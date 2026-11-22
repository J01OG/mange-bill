import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Button } from './ui';

/**
 * Shows "New version ready" instead of reloading by itself, so a cashier is never
 * interrupted in the middle of a bill. Checks for a new version every hour.
 */
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (reg) setInterval(() => reg.update().catch(() => undefined), 60 * 60 * 1000);
    },
  });

  if (!needRefresh) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-50 flex items-center gap-2 bg-blue-700 px-4 py-2 text-white shadow">
      <span className="flex-1 text-sm font-medium">A new version of the app is ready.</span>
      <button className="min-h-10 px-2 text-sm text-blue-100" onClick={() => setNeedRefresh(false)}>
        Later
      </button>
      <button
        className="min-h-10 rounded-lg bg-white px-3 text-sm font-bold text-blue-800"
        onClick={() => {
          updateServiceWorker(true);
          // On a phone's very first visit the page is not yet controlled by the app's
          // service worker, so the automatic reload never comes. Reload ourselves.
          setTimeout(() => window.location.reload(), 3000);
        }}
      >
        Update
      </button>
    </div>
  );
}

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

/** "Install on this phone" card. Android/desktop Chrome: one tap. iPhone: short instructions. */
export function InstallCard() {
  const [evt, setEvt] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(isStandalone());

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as InstallEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return null;
  if (evt)
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-brand-50 p-3 ring-1 ring-brand-100">
        <span className="text-2xl" aria-hidden>
          📲
        </span>
        <span className="flex-1 text-sm">Install the app on this phone. It opens faster and works full screen.</span>
        <Button
          className="min-h-10 px-3 text-sm"
          onClick={async () => {
            await evt.prompt();
            const { outcome } = await evt.userChoice;
            if (outcome === 'accepted') setInstalled(true);
            setEvt(null);
          }}
        >
          Install
        </Button>
      </div>
    );
  if (isIos())
    return (
      <div className="rounded-2xl bg-brand-50 p-3 text-sm ring-1 ring-brand-100">
        📲 To install on iPhone: tap <b>Share</b> (the square with an arrow) → <b>Add to Home Screen</b>.
      </div>
    );
  return null;
}
