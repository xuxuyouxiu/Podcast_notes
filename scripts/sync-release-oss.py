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

    # 校验 latest.yml 可读且含版本号（防传错文件）
    obj = bucket.get_object(f"download/v{version}/latest.yml")
    head = obj.read(256).decode("utf-8", errors="replace")
    if f"version: {version}" not in head:
        sys.exit("[sync-oss] latest.yml 内容校验失败（版本号不符）")
    print(f"[sync-oss] DONE 版本 {version} 已同步至 OSS")


if __name__ == "__main__":
    main()
