/**
 * Canvas Horizon - デスクトップショートカット生成スクリプト
 * ビルド完了後、ユーザーのデスクトップに起動用ショートカット（.lnk）を自動作成します。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const home = os.homedir();

// 通常のデスクトップおよび OneDrive 同期デスクトップの両方に対応
const possibleDesktops = [
  path.join(home, 'OneDrive', 'デスクトップ'),
  path.join(home, 'Desktop'),
  path.join(home, 'デスクトップ')
];

let desktopPath = possibleDesktops.find(p => fs.existsSync(p)) || path.join(home, 'Desktop');

const exeDir = path.join(__dirname, '..', 'build', 'Canvas Horizon-win32-x64');
const exePath = path.join(exeDir, 'Canvas Horizon.exe');
const shortcutPath = path.join(desktopPath, 'Canvas Horizon.lnk');
const icoPath = path.join(__dirname, '..', 'app.ico');

const psScript = [
  '$wsh = New-Object -ComObject WScript.Shell;',
  `$s = $wsh.CreateShortcut('${shortcutPath.replace(/\\/g, '\\\\')}');`,
  `$s.TargetPath = '${exePath.replace(/\\/g, '\\\\')}';`,
  `$s.WorkingDirectory = '${exeDir.replace(/\\/g, '\\\\')}';`,
  `$s.IconLocation = '${icoPath.replace(/\\/g, '\\\\')},0';`,
  `$s.Description = 'Canvas Horizon - Canvas LMS デスクトップクライアント';`,
  '$s.Save();'
].join('\n');

const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
try {
  execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'inherit' });
  console.log('ショートカットを作成しました:');
  console.log('  ショートカット:', shortcutPath);
  console.log('  起動先:', exePath);
} catch (e) {
  console.error('ショートカットの作成に失敗しました:', e.message);
}
