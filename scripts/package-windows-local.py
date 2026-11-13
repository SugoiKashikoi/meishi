"""Assemble a Windows x64 runtime kit from checksum-verified official archives."""
import argparse
import hashlib
import json
import ntpath
from pathlib import Path
import shutil
import struct
import zipfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
for name in ('config', 'node-zip', 'node-shasums', 'electron-zip', 'output'):
    parser.add_argument('--' + name, type=Path, required=True)
args = parser.parse_args()
config = json.loads(args.config.read_text(encoding='utf-8-sig'))
for key in ('dataDir', 'inboxDir'):
    if not isinstance(config.get(key), str) or not ntpath.isabs(config[key]):
        raise ValueError(f'{key} must be an absolute Windows path')
if ntpath.normcase(config['dataDir']) == ntpath.normcase(config['inboxDir']):
    raise ValueError('Data and inbox directories must differ')

def sha(file):
    h = hashlib.sha256()
    with file.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

node_hash = next(line.split()[0] for line in args.node_shasums.read_text().splitlines()
                 if line.split()[-1] == args.node_zip.name)
if sha(args.node_zip) != node_hash:
    raise ValueError('Node archive checksum mismatch')
checksums = json.loads((root / 'node_modules/electron/checksums.json').read_text())
if sha(args.electron_zip) != checksums[args.electron_zip.name]:
    raise ValueError('Electron archive checksum mismatch')

out = args.output.resolve()
archive = Path(str(out) + '.zip')
if out.exists() or archive.exists():
    raise FileExistsError('Refusing to overwrite an existing kit')
out.mkdir(parents=True)

def copy(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination)
    else:
        shutil.copy2(source, destination)

for name in ('package.json', 'AGENTS.md'):
    copy(root / name, out / name)
for name in ('server', 'desktop'):
    copy(root / 'dist' / name, out / 'dist' / name)
(out / 'dist/server/devserver.js').unlink(missing_ok=True)
copy(root / 'public', out / 'public')
copy(root / 'docs', out / 'docs')
for name in ('production-cli.mjs', 'verify-kit.mjs'):
    copy(root / 'scripts' / name, out / 'scripts' / name)
for name in ('index.js', 'cli.js', 'package.json', 'LICENSE', 'checksums.json'):
    copy(root / 'node_modules/electron' / name, out / 'node_modules/electron' / name)
(out / 'node_modules/electron/path.txt').write_text('electron.exe', encoding='ascii')

with zipfile.ZipFile(args.electron_zip) as z:
    destination = out / 'node_modules/electron/dist'
    destination.mkdir()
    for item in z.infolist():
        if not (destination / item.filename).resolve().is_relative_to(destination.resolve()):
            raise ValueError('Unsafe archive path')
    z.extractall(destination)
with zipfile.ZipFile(args.node_zip) as z:
    name = next(n for n in z.namelist() if n.endswith('/node.exe'))
    (out / 'runtime').mkdir()
    (out / 'runtime/node.exe').write_bytes(z.read(name))
    (out / 'runtime/LICENSE-Node.txt').write_bytes(z.read(name.rsplit('/', 1)[0] + '/LICENSE'))

for exe in (out / 'runtime/node.exe', out / 'node_modules/electron/dist/electron.exe'):
    with exe.open('rb') as f:
        if f.read(2) != b'MZ':
            raise ValueError('Not a Windows executable')
        f.seek(0x3c)
        offset = struct.unpack('<I', f.read(4))[0]
        f.seek(offset)
        if f.read(4) != b'PE\0\0' or struct.unpack('<H', f.read(2))[0] != 0x8664:
            raise ValueError('Not Windows x64')
(out / 'meishi-config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
(out / 'work').mkdir()
common = '''@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
"%~dp0runtime\\node.exe" "%~dp0scripts\\verify-kit.mjs"
if errorlevel 1 goto failed
'''
end = '''
set "result=%errorlevel%"
popd
if not "%result%"=="0" pause
exit /b %result%
:failed
popd
pause
exit /b 1
'''
commands = {
    'Start.cmd': '"%~dp0runtime\\node.exe" "%~dp0node_modules\\electron\\cli.js" "%~dp0." "--user-data-dir=%APPDATA%\\MeishiKanri"',
    'Check.cmd': '"%~dp0runtime\\node.exe" "%~dp0scripts\\production-cli.mjs" check\nset "result=%errorlevel%"\npause\npopd\nexit /b %result%',
    'AI.cmd': '"%~dp0runtime\\node.exe" "%~dp0scripts\\production-cli.mjs" %*',
    'Verify.cmd': 'echo Package integrity check completed.\npause',
}
for name, command in commands.items():
    finish = end if name != 'AI.cmd' else end.replace('if not "%result%"=="0" pause\n', '').replace('pause\n', '')
    (out / name).write_bytes((common + command + finish).replace('\n', '\r\n').encode('ascii'))
copy(root / 'docs/Windowsローカル導入.md', out / 'README-FIRST.txt')
request = (
    "AGENTS.md と docs/AI登録の手順.md を読んで名刺を登録してください。\n"
    "実行環境は同梱済みです。npm ci・ビルドは不要です。runtime/node.exe を使います。\n"
    f"保存先: {config['dataDir']}\n取り込み用: {config['inboxDir']}\n"
    "基本は表面1枚です。読めない項目は空にし、推測で補わないでください。\n"
    "フォームはこのPCの work/form.json に作り、次で試し実行します。\n"
    '  .\\AI.cmd dry-run ".\\work\\form.json"\n'
    "work/preview の切り抜き画像も確認してください。初回は結果を私に見せ、登録対象を確認してから次を実行します。\n"
    '  .\\AI.cmd register ".\\work\\form.json"\n'
    "cards/imagesを直接変更せず、登録後の元写真の移動もコマンドに任せてください。\n"
    "登録件数・失敗・重複候補・移動失敗を報告し、今回作成したフォームとプレビューは処理後に片付けてください。\n"
)
(out / 'AI-REQUEST.txt').write_text(request, encoding='utf-8-sig')
files = {f.relative_to(out).as_posix(): sha(f) for f in sorted(out.rglob('*'))
         if f.is_file() and f.name != 'meishi-config.json'}
(out / 'SHA256.json').write_text(json.dumps({'files': files, 'excluded': ['meishi-config.json', 'work/']}, indent=2))
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    z.write(out / 'work', str(Path(out.name) / 'work'))
    for file in sorted(out.rglob('*')):
        if file.is_file():
            z.write(file, str(Path(out.name) / file.relative_to(out)))
Path(str(archive) + '.sha256').write_text(sha(archive) + '  ' + archive.name + '\n', encoding='ascii')
print(json.dumps({'archive': str(archive), 'size': archive.stat().st_size, 'files': len(files), 'sha256': sha(archive)}))
