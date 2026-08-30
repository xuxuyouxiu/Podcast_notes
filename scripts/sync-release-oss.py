# -*- coding: utf-8 -*-
"""发布产物同步到阿里云 OSS（GitHub Actions 中运行）

上传策略：
- 新版安装包 / blockmap / latest.yml 上传到 download/v{version}/（安装包不可变 → 长缓存）
- latest.yml 的 files[].url 与 path 改写为绝对 URL（指向新版本目录）后，
  同步一份到**所有已存在的 download/v*/ 目录** + 固定路径 download/latest.yml：
  - 应用内更新器（src/main/updater.ts 通道 0）探测的是「当前运行版本自己的目录」，
    读到自己目录里的 yml 才能发现新版本；yml 内绝对 URL 使下载直达新版本目录，
    无需把 115MB 安装包复制进每个历史目录（海外 runner 跨洋上传极慢，v1.52.11 踩坑）。
  - electron-updater 用 new URL(file.url, feedBase) 解析，绝对 URL 直接生效（v6.8.9 已验证）。
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
    public_base = os.environ.get("OSS_PUBLIC_BASE", "https://dl.xuxuya66.top").rstrip("/")

    if not (ak and sk and endpoint):
        print("[sync-oss] OSS Secrets 未配置（OSS_AK_ID/OSS_AK_SECRET/OSS_ENDPOINT），跳过同步")
        return

    try:
        import oss2
        import yaml
    except ImportError as e:
        sys.exit(f"[sync-oss] 缺少依赖（oss2 / pyyaml）：{e}")

    version = json.load(open("package.json", encoding="utf-8"))["version"]
    auth = oss2.Auth(ak, sk)
    bucket = oss2.Bucket(auth, endpoint, bucket_name)

    dist = "dist-exe"
    targets = [
        (f"PodMuse-Setup-{version}.exe", "max-age=31536000, immutable"),
        (f"PodMuse-Setup-{version}.exe.blockmap", "max-age=31536000, immutable"),
    ]

    for fname, cache in targets:
        local = os.path.join(dist, fname)
        if not os.path.exists(local):
            sys.exit(f"[sync-oss] 缺少构建产物: {local}")
        key = f"download/v{version}/{fname}"
        bucket.put_object_from_file(key, local, headers={"CacheControl": cache})
        print(f"[sync-oss] OK {key}")

    # 改写 latest.yml：下载地址改为绝对 URL，指向新版本目录
    # （files[].url 与 path 都改，兼容 electron-updater 的两种读取路径）
    info = yaml.safe_load(open(os.path.join(dist, "latest.yml"), encoding="utf-8"))
    for f in info.get("files", []):
        if "url" in f and not str(f["url"]).startswith("http"):
            f["url"] = f"{public_base}/download/v{version}/{f['url']}"
    if info.get("path") and not str(info["path"]).startswith("http"):
        info["path"] = f"{public_base}/download/v{version}/{info['path']}"
    yml_body = yaml.safe_dump(info, allow_unicode=True, default_flow_style=False, sort_keys=True)

    yml_cache = {"CacheControl": "no-cache"}
    bucket.put_object("download/v{v}/latest.yml".format(v=version), yml_body.encode("utf-8"), headers=yml_cache)
    print(f"[sync-oss] OK download/v{version}/latest.yml（绝对 URL）")

    # 固定路径副本（不带版本号）：供官网/外部探测「最新版本号」
    bucket.put_object("download/latest.yml", yml_body.encode("utf-8"), headers=yml_cache)
    print("[sync-oss] OK download/latest.yml")

    # 镜像 yml 到所有历史版本目录（每个仅 2KB）：应用内更新器探测的是
    # 「当前运行版本自己的目录」，老客户端在自己目录内发现新版本后，
    # 经 yml 里的绝对 URL 直达新版本目录下载安装包。
    seen_dirs = set()
    for obj in oss2.ObjectIterator(bucket, prefix="download/v"):
        m = re.match(r"download/(v[^/]+)/", obj.key)
        if m:
            seen_dirs.add(m.group(1))
    seen_dirs.discard(f"v{version}")
    for d in sorted(seen_dirs):
        key = f"download/{d}/latest.yml"
        bucket.put_object(key, yml_body.encode("utf-8"), headers=yml_cache)
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
