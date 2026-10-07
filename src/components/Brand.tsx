import React from 'react';

export const APP_NAME = 'SyncroBeat';
export const TAGLINE = 'Tu ritmo, siempre';

export function Brand({ hero = false }: { hero?: boolean }) {
  if (hero) {
    return (
      <div className="flex flex-col items-center gap-3">
        <h1 className="sr-only">{APP_NAME}</h1>
        <img src="/syncrobeat-logo.svg" alt="" width={818} height={462} className="w-60 h-auto" />
        <p className="text-[11px] font-medium uppercase tracking-[0.35em] text-neutral-300">{TAGLINE}</p>
      </div>
    );
  }
  return (
    <div className="flex items-center shrink-0">
      <img src="/syncrobeat-icon.svg" alt="" width={36} height={36} className="w-9 h-9 sm:hidden" />
      <img src="/syncrobeat-logo-horizontal.svg" alt={APP_NAME} width={508} height={118} className="hidden sm:block h-8 w-auto" />
      <span className="sr-only sm:hidden">{APP_NAME}</span>
    </div>
  );
}
