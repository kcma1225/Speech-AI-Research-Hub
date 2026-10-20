#!/usr/bin/env python3
"""Extract pinned browser and font/math artifacts into renderer image."""
import hashlib
import http.client
import io
import re
import tarfile
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path('/opt/slide-assets')
BASE.mkdir(parents=True, exist_ok=True)
PACKAGES = {
    'katex': ('https://registry.npmjs.org/katex/-/katex-0.16.11.tgz', '8c5494c5f7d8e8bf73ff3fe64d4bd09a340e4878b7eec9bbd9ef8d8f3e24193f'),
    'mathjax': ('https://registry.npmjs.org/mathjax/-/mathjax-2.7.9.tgz', '7131e739848edc14aa661a5516995866b81a477fab8b039d7cc324930e71f786'),
    'noto-sans-tc': ('https://registry.npmjs.org/@fontsource/noto-sans-tc/-/noto-sans-tc-5.3.1.tgz', 'c34c3ec21eb325aec1a6c3689bc0dc6c7b830a2b05dcb1d443e3a61ac05cd0ef'),
    'source-sans-3': ('https://registry.npmjs.org/@fontsource/source-sans-3/-/source-sans-3-5.3.1.tgz', 'b598201d980b3512805bbea186aab8ef91590d59990e6a13c90e030b6ff37881'),
    'source-code-pro': ('https://registry.npmjs.org/@fontsource/source-code-pro/-/source-code-pro-5.3.1.tgz', '52ff8925aa275d3d28b745760ab78e9ac11276a477c909f1a8e703e0902afcc4'),
}
def download_https(url: str, timeout: int) -> bytes:
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ('registry.npmjs.org', 'storage.googleapis.com'):
        raise ValueError('Unexpected download origin')
    connection = http.client.HTTPSConnection(parts.hostname, timeout=timeout)
    try:
        connection.request('GET', parts.path)
        response = connection.getresponse()
        if response.status != 200:
            raise ValueError(f'Download failed: {response.status}')
        return response.read()
    finally:
        connection.close()


def extract_member(archive: tarfile.TarFile, members: dict[str, tarfile.TarInfo], source: str, dest: Path) -> bytes:
    stream = archive.extractfile(members[source])
    if stream is None:
        raise ValueError(f'Missing archive member: {source}')
    content = stream.read()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    return content


CSS = []
for name, (url, digest) in PACKAGES.items():
    data = download_https(url, 120)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f'Checksum mismatch: {name}')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = {member.name: member for member in archive if member.isfile()}
        extract_member(archive, members, 'package/LICENSE', BASE / 'licenses' / f'{name}.txt')
        if name == 'katex':
            for source in members:
                if source in ('package/dist/katex.min.js', 'package/dist/katex.min.css') or re.fullmatch(r'package/dist/fonts/[^/]+\.woff2', source):
                    extract_member(archive, members, source, BASE / 'katex' / source.removeprefix('package/dist/'))
        elif name == 'mathjax':
            for source in members:
                if source == 'package/MathJax.js' or source.startswith(('package/config/', 'package/extensions/', 'package/jax/', 'package/fonts/')):
                    extract_member(archive, members, source, BASE / 'mathjax' / source.removeprefix('package/'))
        else:
            sub = BASE / 'fonts' / name
            weights = (300, 400, 500, 600) if name != 'source-code-pro' else (400, 500)
            groups = ('chinese-traditional', 'latin') if name == 'noto-sans-tc' else ('latin',)
            for weight in weights:
                for group in groups:
                    source = f'package/{group}-{weight}.css'
                    css = extract_member(archive, members, source, sub / f'{group}-{weight}.css').decode()
                    for file in set(re.findall(r'files/[^)]+\.woff2', css)):
                        extract_member(archive, members, 'package/' + file, sub / file)
                    css = re.sub(r', url\([^)]*\.woff\) format\([^)]+\)', '', css)
                    css = css.replace('url(./files/', f'url(./fonts/{name}/files/')
                    CSS.append(css)
(BASE / 'fonts.css').write_text('\n'.join(CSS))

url = 'https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.82/linux64/chrome-headless-shell-linux64.zip'
data = download_https(url, 180)
if hashlib.sha256(data).hexdigest() != 'b5b449157b430c4f25481192bb94c723e3cb170ec755ae502f9d3849e4cc2043':
    raise ValueError('Checksum mismatch: Chrome Headless Shell')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for member in archive.infolist():
        if member.is_dir():
            continue
        relative = Path(member.filename)
        if '..' in relative.parts or relative.parts[0] != 'chrome-headless-shell-linux64':
            raise ValueError('Unsafe browser archive')
        dest = Path('/opt/chrome').joinpath(*relative.parts[1:])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(archive.read(member))
        dest.chmod(member.external_attr >> 16 or 0o644)
