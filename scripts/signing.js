// Makes the generated Android project sign every build with signing/debug.keystore,
// so each new APK installs as an update over the previous one.
const fs = require("fs");
const path = require("path");
const gradle = path.join(__dirname, "..", "android", "app", "build.gradle");
let s = fs.readFileSync(gradle, "utf8");
if (!s.includes("srkSigning")) {
  const block = `
    signingConfigs {
        srkSigning {
            storeFile file("../../signing/debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
`;
  s = s.replace(/android\s*\{/, (m) => m + block);
  s = s.replace(/buildTypes\s*\{/, (m) => m + `
        debug {
            signingConfig signingConfigs.srkSigning
        }`);
  fs.writeFileSync(gradle, s);
}
console.log("Signing config set in", gradle);
