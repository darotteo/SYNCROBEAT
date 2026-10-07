import React, { useState, useEffect } from 'react';
import { Copy, Check, Share2 } from 'lucide-react';
import { Button, Modal } from './ui';

interface ShareRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomId: string;
}

export const ShareRoomModal: React.FC<ShareRoomModalProps> = ({ isOpen, onClose, roomId }) => {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // In Google AI Studio the "dev-" preview URL is private; the "pre-" one can be opened from other devices
  const origin = window.location.origin.includes('dev-')
    ? window.location.origin.replace('dev-', 'pre-')
    : window.location.origin;
  const shareUrl = `${origin}/?room=${encodeURIComponent(roomId)}`;

  useEffect(() => {
    if (!isOpen) return;
    // Generated locally so it also works offline; the QR library only loads when inviting
    import('qrcode')
      .then((QRCode) =>
        QRCode.toDataURL(shareUrl, {
          width: 480,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'M',
        })
      )
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [isOpen, shareUrl]);

  const handleCopy = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleNativeShare = async () => {
    if (!navigator.share) {
      handleCopy();
      return;
    }
    try {
      await navigator.share({
        title: `SyncroBeat · Sala ${roomId}`,
        text: `Entrá a la sala ${roomId} de SyncroBeat para tocar con el mismo click:`,
        url: shareUrl,
      });
    } catch {
      // Cancelled by the user
    }
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Invitar a la banda" subtitle="Escaneá el código o mandá el link" size="sm">
      <div className="flex flex-col items-center gap-3">
        <div className="w-56 h-56 rounded-3xl bg-white p-3 flex items-center justify-center">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`Código QR para entrar a la sala ${roomId}`} className="w-full h-full" />
          ) : (
            <span className="text-xs text-neutral-500">Generando…</span>
          )}
        </div>
        <div className="text-center">
          <div className="text-xs text-neutral-500">Código de sala</div>
          <div className="text-2xl font-light tracking-widest text-white">{roomId}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 pl-4 pr-1 h-12 rounded-2xl bg-surface-2">
        <span className="flex-1 min-w-0 truncate text-sm text-neutral-400">{shareUrl}</span>
        <Button size="sm" onClick={handleCopy} className="bg-surface-3 shrink-0">
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>

      <Button variant="primary" size="md" onClick={handleNativeShare} className="w-full">
        <Share2 className="w-4 h-4" />
        Compartir link
      </Button>
    </Modal>
  );
};
