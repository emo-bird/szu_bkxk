# -*- coding: utf-8 -*-
"""发布 GitHub 发行（Release）并把成品 zip 作为附件上传。

用法（在项目根目录）：::

    # 1) 先打包：双击 build.bat 或手工执行 PyInstaller（见 README 十三）
    # 2) 取得 token（Windows 上 git 已存好凭据时可用下面这行取出）
    $env:GH_TOKEN = ((("protocol=https`nhost=github.com`n`n" | git credential fill |
        Select-String '^password=') -replace '^password=','').Trim())
    # 3) 发布
    .\\.venv\\Scripts\\python.exe tools\\publish_release.py

脚本会自动完成：
    · 版本号取自 ``config.APP_VERSION``，tag 为 ``v<版本>``；
    · 发行说明取自 ``build/release_notes.md``（不存在则用简短摘要）；
    · 仓库地址取自 ``git remote get-url origin``；
    · 若同名发行已存在则**更新**说明，附件已存在则跳过上传；
    · 创建/更新发行前会先把 tag 推送到远端（需要 git 凭据）。

凭据只从环境变量 ``GH_TOKEN`` 读取，**不会被打印或写入任何文件**。

--------------------------------------------------------------------------
⚠️ 本程序仅用于技术学习研究。开发、求证、测试阶段禁止调用选课、退课接口。
--------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def repo_slug() -> str:
    """从 git 远端地址解析出 ``owner/name``。

    :return: 形如 ``emo-bird/szu_bkxk`` 的仓库标识。
    """
    url = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    match = re.search(r"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?$", url)
    if not match:
        raise SystemExit(f"无法从远端地址解析仓库：{url!r}")
    return f"{match.group(1)}/{match.group(2)}"


def http(
    method: str, url: str, payload: object | bytes | None = None, content_type: str = "application/json"
) -> tuple[int, dict]:
    """发一个 GitHub API 请求。

    :param method: HTTP 方法。
    :param url: 完整地址。
    :param payload: 字典（转 JSON）或原始字节（上传附件）。
    :param content_type: 请求体类型。
    :return: ``(状态码, 响应字典)``；失败时字典含 ``error`` 键。
    """
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "szu_bkxk-release",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body: bytes | None = None
    if payload is not None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, {"error": exc.read().decode("utf-8", "replace")[:600]}


TOKEN = os.environ.get("GH_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit(
        "缺少 GH_TOKEN 环境变量。可先执行：\n"
        "  $env:GH_TOKEN = ((('protocol=https`nhost=github.com`n`n' | git credential fill) "
        "| Select-String '^password=') -replace '^password=','').Trim()"
    )

import config  # noqa: E402 - 需要在 sys.path 就绪后导入

VERSION = config.APP_VERSION
TAG = f"v{VERSION}"
REPO = repo_slug()
ZIP = ROOT / "build" / f"szu_bkxk-{TAG}-win64.zip"
NOTES_FILE = ROOT / "build" / "release_notes.md"
API = f"https://api.github.com/repos/{REPO}"

if not ZIP.exists():
    raise SystemExit(f"未找到成品：{ZIP}\n请先按 README 十三打包（确保 zip 名为 szu_bkxk-{TAG}-win64.zip）。")

notes = NOTES_FILE.read_text(encoding="utf-8") if NOTES_FILE.exists() else f"szu_bkxk {TAG}"
title = f"szu_bkxk {TAG}"

print(f"仓库 = {REPO}｜tag = {TAG}｜成品 = {ZIP.name}（{ZIP.stat().st_size / 1024 / 1024:.1f} MB）")

if subprocess.run(["git", "tag", "--list", TAG], cwd=ROOT, capture_output=True, text=True).stdout.strip():
    print(f"推送 tag {TAG} …")
    subprocess.run(["git", "push", "origin", TAG], cwd=ROOT)
else:
    print(f"[警告] 本地不存在 tag {TAG}，将直接由 API 在默认分支上创建同名 tag")

status, existing = http("GET", f"{API}/releases/tags/{TAG}")
payload = {
    "tag_name": TAG,
    "name": title,
    "body": notes,
    "draft": False,
    "prerelease": False,
    "generate_release_notes": False,
}
if status == 200:
    print(f"同名发行已存在（id={existing['id']}），更新说明")
    code, release = http("PATCH", f"{API}/releases/{existing['id']}", payload)
else:
    code, release = http("POST", f"{API}/releases", payload)

if code >= 400:
    raise SystemExit(f"创建发行失败（{code}）：{release.get('error', '')[:600]}")
print(f"发行就绪：{release['html_url']}")

upload_url = str(release.get("upload_url", "")).split("{")[0]
if ZIP.name in {asset["name"] for asset in release.get("assets", [])}:
    print(f"附件 {ZIP.name} 已存在，跳过上传")
else:
    print("上传附件 …")
    code, asset = http("POST", f"{upload_url}?name={ZIP.name}", ZIP.read_bytes(), "application/zip")
    if code >= 400:
        print(f"附件上传失败（{code}）：{asset.get('error', '')[:300]}")
    else:
        print(f"已上传：{asset['name']}  {asset['size'] / 1024 / 1024:.1f} MB")
        print(f"下载地址：{asset['browser_download_url']}")
