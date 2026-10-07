import React from 'react';
import { Volume2 } from 'lucide-react';
import { audioEngine } from '../utils/audioEngine';
import { Button, Modal, SectionLabel, Toggle } from './ui';

interface LockScreenGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDrummer: boolean;
  keepScreenAwake: boolean;
  onToggleKeepScreenAwake: (val: boolean) => void;
}

export const LockScreenGuideModal: React.FC<LockScreenGuideModalProps> = ({
  isOpen,
  onClose,
  isDrummer,
  keepScreenAwake,
  onToggleKeepScreenAwake,
}) => (
  <Modal open={isOpen} onClose={onClose} title="Con el celular bloqueado" subtitle="La reproducción en segundo plano depende del dispositivo">
    <section>
      <SectionLabel>{isDrummer ? 'Como baterista' : 'Como músico'}</SectionLabel>
      <ul className="flex flex-col gap-2 text-sm text-neutral-300 leading-relaxed">
        {isDrummer ? (
          <>
            <li>Iniciá o detené a toda la banda desde los controles de la pantalla de bloqueo o de tus auriculares.</li>
            <li>Con «siguiente» y «anterior» cambiás de tema del setlist sin desbloquear.</li>
          </>
        ) : (
          <>
            <li>Probá si el click continúa al apagar la pantalla antes de usarlo con el celular en el bolsillo.</li>
            <li>Play y pausa en la pantalla de bloqueo silencian o activan solo tu click.</li>
          </>
        )}
      </ul>
    </section>

    <section>
      <SectionLabel>En iPhone</SectionLabel>
      <ul className="flex flex-col gap-2 text-sm text-neutral-300 leading-relaxed list-disc pl-5">
        <li>Sin auriculares, el interruptor lateral de silencio tiene que estar en sonido.</li>
        <li>Al entrar a la sala tocá la pantalla una vez para habilitar el audio.</li>
        <li>Para mantener el pulso, dejá la app visible y la pantalla encendida. iOS puede suspender el audio al bloquear el celular o cambiar de app.</li>
        <li>Al volver, si aparece «Activar el sonido», tocá ese botón para recuperar el pulso actual de la sala.</li>
      </ul>
    </section>

    <section className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm text-white">Mantener pantalla encendida</div>
        <div className="text-xs text-neutral-500">Útil si el celular queda en el atril</div>
      </div>
      <Toggle checked={keepScreenAwake} onChange={onToggleKeepScreenAwake} label="Mantener pantalla encendida" />
    </section>

    <Button
      size="md"
      className="w-full"
      onClick={() => {
        audioEngine.unlockAudio();
        audioEngine.playTestClick(true);
      }}
    >
      <Volume2 className="w-4 h-4" />
      Probar sonido
    </Button>
  </Modal>
);
