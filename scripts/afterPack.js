const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    try {
      execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
    } catch (err) {
      console.error('xattr clear failed:', err.message);
    }
  } catch (err) {
    console.error('ad-hoc codesign failed:', err.message);
    throw err;
  }
};
