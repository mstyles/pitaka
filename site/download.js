// Points the download links at the latest release's files, and the main
// button at the installer for the visitor's OS. Without this (no script,
// or GitHub's API rate limit), every link opens the latest release page.

const RELEASE_API = "https://api.github.com/repos/mstyles/pitaka/releases/latest";

function visitorOs() {
  const platform = navigator.userAgentData?.platform ?? navigator.userAgent;
  if (/Windows/i.test(platform)) return "windows";
  // Android's user agent says Linux too, but it can't run the AppImage.
  if (/Linux/i.test(platform) && !/Android/i.test(navigator.userAgent)) return "linux";
  return null;
}

const MAIN_DOWNLOAD = {
  windows: { suffix: "-setup.exe", label: "Download for Windows" },
  linux: { suffix: ".AppImage", label: "Download for Linux" },
};

async function linkLatestRelease() {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) return;
  const release = await response.json();
  const assetUrl = (suffix) =>
    release.assets.find((asset) => asset.name.endsWith(suffix))?.browser_download_url;

  for (const link of document.querySelectorAll("a[data-asset]")) {
    const url = assetUrl(link.dataset.asset);
    if (url) link.href = url;
  }
  document.getElementById("version").textContent =
    `Version ${release.tag_name.replace(/^v/, "")}`;

  const main = MAIN_DOWNLOAD[visitorOs()];
  const url = main && assetUrl(main.suffix);
  if (url) {
    const button = document.getElementById("download");
    button.href = url;
    button.textContent = main.label;
  }
}

linkLatestRelease().catch(() => {});
