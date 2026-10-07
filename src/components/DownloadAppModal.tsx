import React from 'react';
import { Download, Share, PlusSquare, MoreVertical } from 'lucide-react';
import { Button, Modal, SectionLabel } from './ui';

interface DownloadAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  onInstallNative: () => void;
  canPromptNative: boolean;
  isIOS: boolean;
  isInstalled: boolean;
}

const Step: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
  <li className="flex gap-3 text-sm text-neutral-300 leading-relaxed">
    <span className="w-6 h-6 rounded-full bg-surface-2 text-xs text-neutral-400 flex items-center justify-center shrink-0 mt-0.5">{n}</span>
    <span>{children}</span>
  </li>
);

const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-2 text-white text-xs align-middle">{children}</span>
);

export const DownloadAppModal: React.FC<DownloadAppModalProps> = ({
  isOpen,
  onClose,
  onInstallNative,
  canPromptNative,
  isIOS,
  isInstalled,
}) => (
  <Modal
    open={isOpen}
    onClose={onClose}
    title="Instalar SyncroBeat"
    subtitle="Queda como una app: pantalla completa, ícono propio y funciona sin conexión"
  >
    {isInstalled && (
      <p className="text-sm text-accent">SyncroBeat ya está instalada en este dispositivo.</p>
    )}

    {canPromptNative && !isInstalled && (
      <Button variant="primary" size="lg" onClick={onInstallNative} className="w-full">
        <Download className="w-5 h-5" />
        Instalar ahora
      </Button>
    )}

    {(isIOS || !canPromptNative) && (
      <section>
        <SectionLabel>iPhone / iPad (Safari)</SectionLabel>
        <ol className="flex flex-col gap-3">
          <Step n={1}>
            Tocá <Key><Share className="w-3 h-3" /> Compartir</Key> en la barra de Safari.
          </Step>
          <Step n={2}>
            Elegí <Key><PlusSquare className="w-3 h-3" /> Agregar a inicio</Key>.
          </Step>
          <Step n={3}>Confirmá con «Agregar».</Step>
        </ol>
      </section>
    )}

    {!isIOS && (
      <section>
        <SectionLabel>Android / computadora (Chrome, Edge)</SectionLabel>
        <ol className="flex flex-col gap-3">
          <Step n={1}>
            Abrí el menú <Key><MoreVertical className="w-3 h-3" /></Key> del navegador.
          </Step>
          <Step n={2}>Elegí «Instalar aplicación» o «Agregar a la pantalla principal».</Step>
        </ol>
      </section>
    )}
  </Modal>
);
