import { useEffect, useState } from 'react';
import { Download, Monitor, Laptop, Car } from 'lucide-react';

const VERSION = '0.1.6';
const RELEASE_API = `https://api.github.com/repos/tylerplauche/Daisy-Protocol/releases/tags/vehicledesk-v${VERSION}`;
const platforms = [
  { name: 'Windows', detail: 'Windows 11+ · 64-bit', file: `VehicleDesk-${VERSION}-Windows-x64.exe`, label: 'Download for Windows', Icon: Monitor },
  { name: 'Mac · Apple silicon', detail: 'M1, M2, M3, M4 or newer · macOS 14+', file: `VehicleDesk-${VERSION}-macOS-AppleSilicon.dmg`, label: 'Download for Apple silicon', Icon: Laptop },
  { name: 'Mac · Intel', detail: 'Intel-based Mac · macOS 14+', file: `VehicleDesk-${VERSION}-macOS-Intel.dmg`, label: 'Download for Intel Mac', Icon: Laptop },
];
type Asset = { name: string; browser_download_url: string; size: number };
export default function Downloads() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    setStatus('loading');
    fetch(RELEASE_API, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } })
      .then(async response => {
        if (!response.ok) throw new Error('Release unavailable');
        const release = await response.json();
        if (release.draft || !Array.isArray(release.assets)) throw new Error('Release unavailable');
        const verified = release.assets.filter((asset: Asset) => {
          if (!platforms.some(platform => platform.file === asset.name) || !Number.isFinite(asset.size) || asset.size <= 0) return false;
          try {
            const url = new URL(asset.browser_download_url);
            return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname === `/tylerplauche/Daisy-Protocol/releases/download/vehicledesk-v${VERSION}/${asset.name}`;
          } catch { return false; }
        });
        setAssets(verified); setStatus('ready');
      }).catch(() => { if (!controller.signal.aborted) setStatus('error'); else if (!disposed) setStatus('error'); })
      .finally(() => clearTimeout(timeout));
    let disposed = false;
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);
  return <section className="section download-section" id="downloads" aria-labelledby="downloads-heading"><div className="wrap">
    <div className="download-intro"><p className="eyebrow">DAISY PROTOCOL DOWNLOADS</p><h2 id="downloads-heading">Practical tools. On your computer.</h2>
      <div className="download-title"><Car aria-hidden="true"/><h3>VehicleDesk</h3></div><span className="download-version">Version {VERSION} · Desktop preview</span>
      <p className="body-lead">Find vehicle listings, review promising candidates, and approve messages before sending. Keep your leads and saved searches on your own computer.</p>
      <p>Choose OpenAI, Claude, or a local model such as gpt-oss. The same app includes all three options.</p>
    </div>
    <div className="download-grid">{platforms.map(({name, detail, file, label, Icon}) => {
      const asset = assets.find(item => item.name === file);
      return <article className="download-card" key={file}><Icon aria-hidden="true"/><h4>{name}</h4><p>{detail}</p>
        {asset ? <><a className="button" href={asset.browser_download_url}><Download aria-hidden="true"/>{label}</a><small className="download-size">{Math.round(asset.size / 1024 / 1024)} MB · {file.endsWith('.exe') ? 'EXE installer' : 'DMG installer'}</small></> : <span className="download-unavailable">{status === 'loading' ? 'Checking downloads…' : status === 'error' ? 'Download temporarily unavailable' : 'Installer being prepared'}</span>}
      </article>;
    })}</div>
    <p className="download-status" role="status">{status === 'loading' ? 'Checking the latest release…' : status === 'error' ? 'Could not load the installers. Please try again.' : assets.length === 3 ? 'All installers are ready to download. No GitHub account required.' : 'New installers are being prepared. Available downloads appear above.'}{status !== 'loading' && assets.length < 3 && <button onClick={() => setAttempt(value => value + 1)}>Refresh downloads</button>}</p>
    <div className="download-setup"><div><h4>1. Install and connect</h4><p>On Mac, open the DMG and drag VehicleDesk into Applications. On Windows, run the installer. Sign into Facebook once, then reconnect whenever your session expires.</p></div><div><h4>2. Choose your AI</h4><p>In Settings, enter your own OpenAI or Claude API key, or connect a local server in Ollama or LM Studio. Local models and their runtime are installed separately. Cloud usage is billed by your chosen provider.</p></div></div>
    <p className="caption">Preview installers are unsigned; review your operating system’s prompts before installing. Your API keys stay in your computer’s secure credential storage. Only collect listings you have permission to access, and review each message before sending.</p>
  </div></section>;
}
