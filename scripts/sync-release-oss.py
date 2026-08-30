# -*- coding: utf-8 -*-
"""发布产物同步到阿里云 OSS（GitHub Actions 中运行）

把 dist-exe 下的安装包 / blockmap / latest.yml 上传到 download/v{version}/：
- 安装包与 blockmap 内容不可变 → Cache-Control 长缓存
- latest.yml 是更新探测入口 → no-cache（必须永远拿到最新）
密钥从环境变量读取（仓库 Secrets：OSS_AK_ID / OSS_AK_SECRET / OSS_ENDPOINT）；
Secrets 未配置时警告并跳过（退出码 0），不阻塞 Release 流程。
"""
import json
import os
import re
import sys


def main() -> None:
    ak = os.environ.get("OSS_AK_ID", "")
    sk = os.environ.get("OSS_AK_SECRET", "")
    endpoint = os.environ.get("OSS_ENDPOINT", "")
    bucket_name = os.environ.get("OSS_BUCKET", "podmuse")

    if not (ak and sk and endpoint):
        print("[sync-oss] OSS Secrets 未配置（OSS_AK_ID/OSS_AK_SECRET/OSS_ENDPOINT），跳过同步")
        return

    try:
        import oss2
    except ImportError:
        sys.exit("[sync-oss] 缺少依赖：请先 pip install oss2")

    version = json.load(open("package.json", encoding="utf-8"))["version"]
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    dist = "dist-exe"
    targets = [
        (f"PodMuse-Setup-{version}.exe", "max-age=31536000, immutable"),
        (f"PodMuse-Setup-{version}.exe.blockmap", "max-age=31536000, immutable"),
        ("latest.yml", "no-cache"),
    ]

    for fname, cache in targets:
        local = os.path.join(dist, fname)
        if not os.path.exists(local):
            sys.exit(f"[sync-oss] 缺少构建产物: {local}")
        key = f"download/v{version}/{fname}"
        bucket.put_object_from_file(key, local, headers={"CacheControl": cache})
        print(f"[sync-oss] OK {key}")

    # 固定路径副本（不带版本号）：供官网/外部探测「最新版本号」，
    # 否则探测方必须先知道版本号才能拼出带版本的路径（鸡生蛋）
    bucket.put_object_from_file(
        "download/latest.yml", os.path.join(dist, "latest.yml"), headers={"CacheControl": "no-cache"}
    )
    print("[sync-oss] OK download/latest.yml")

    # 镜像到所有历史版本目录 —— 关键修复（v1.52.11）：
    # 应用内更新器的 OSS 通道探测的是「当前运行版本自己的目录」
    # （download/v{运行版本}/latest.yml，见 src/main/updater.ts 通道 0）。
    # 若各目录只放自己版本的 yml，OSS 通道结构上永远检测不到更新——
    # 1.52.9 客户端读 v1.52.9/latest.yml 得到 1.52.9 → 恒报「已是最新」。
    # 因此每次发布把新版 latest.yml + 安装包 + blockmap 镜像进所有已存在的 v*/ 目录，
    # 任意旧版本客户端都能在自己目录内完成更新检测与下载（相对路径就近解析）。
    # 注意：旧目录会随版本数累积安装包副本（每版 ~110MB），必要时可在 OSS 控制台手动清理。
    seen_dirs = set()
    for obj in oss2.ObjectIterator(bucket, prefix="download/v"):
        m = re.match(r"download/(v[^/]+)/", obj.key)
        if m:
            seen_dirs.add(m.group(1))
    seen_dirs.discard(f"v{version}")  # 当前版本目录已直接上传过
    for d in sorted(seen_dirs):
        for fname, cache in targets:
            key = f"download/{d}/{fname}"
            bucket.put_object_from_file(
                key, os.path.join(dist, fname), headers={"CacheControl": cache}
            )
            print(f"[sync-oss] MIRROR {key}")
    if seen_dirs:
        print(f"[sync-oss] 已镜像 {len(seen_dirs)} 个历史版本目录: {', '.join(sorted(seen_dirs))}")

    # 校验 latest.yml 可读且含版本号（防传错文件）
    obj = bucket.get_object(f"download/v{version}/latest.yml")
    head = obj.read(256).decode("utf-8", errors="replace")
    if f"version: {version}" not in head:
        sys.exit("[sync-oss] latest.yml 内容校验失败（版本号不符）")
    print(f"[sync-oss] DONE 版本 {version} 已同步至 OSS")


if __name__ == "__main__":
    main()
