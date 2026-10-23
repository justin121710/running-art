"""依檔案內容更新所有快取版本號。

瀏覽器（和 Service Worker）靠網址上的 ?v= 判斷檔案有沒有換新。以前要手動改，
忘記改就會讓使用者跑舊程式。改完任何 .js / gpsart/*.py 之後執行：

    python tools/stamp_versions.py          # 更新
    python tools/stamp_versions.py --check  # 只檢查（CI 用），過期就回傳 1
"""
import glob
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def h(*paths):
    m = hashlib.sha256()
    for p in paths:
        with open(os.path.join(ROOT, p), 'rb') as f:
            m.update(f.read())
    return m.hexdigest()[:10]


def sub(path, pattern, value, changed):
    full = os.path.join(ROOT, path)
    with open(full, encoding='utf-8') as f:
        s = f.read()
    new = re.sub(pattern, lambda m: m.group(1) + value + m.group(2), s)
    if new != s:
        changed.append(path)
        if '--check' not in sys.argv:
            with open(full, 'w', encoding='utf-8') as f:
                f.write(new)


def main():
    changed = []
    py = sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, 'gpsart', '*.py')))
    sub('engine-worker.js', r"(const VERSION = ')[^']*(';)", h(*py), changed)
    sub('engine.js', r"(engine-worker\.js\?v=)[^']*(')", h('engine-worker.js'), changed)
    js = sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, 'js', '*.js')))
    for f in ['engine.js'] + js:
        name = re.escape(f)
        sub('index.html', r'(src="' + name + r'\?v=)[^"]*(")', h(f), changed)
    app = ['index.html', 'engine.js', 'engine-worker.js'] + js + py
    sub('sw.js', r"(const VERSION = ')[^']*(';)", h(*app), changed)
    if changed:
        print(('過期：' if '--check' in sys.argv else '已更新：') + ', '.join(changed))
        if '--check' in sys.argv:
            print('請執行 python tools/stamp_versions.py 後再 commit')
            return 1
    else:
        print('版本號都是最新的')
    return 0


if __name__ == '__main__':
    sys.exit(main())
