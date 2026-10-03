# -*- coding: utf-8 -*-
"""算 dist/ 全量内容清单的哈希。

用途：证明**自检不写产物** —— 上传的东西必须等于构建产物本身。
如果跑了 self-test 之后哈希变了，说明自检改动了要发布的内容，
那「本地全绿」就不再代表「线上跑的是这一份」。

用法： python tools/dist_manifest_hash.py [目录，默认 dist]
"""
import hashlib
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else "dist"

h = hashlib.sha256()
files = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in sorted(filenames):
        p = os.path.join(dirpath, name)
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(p, "rb") as f:
            h.update(f.read())
        files += 1

print(f"{h.hexdigest()[:16]}  ({files} 个文件)")
