# SyncroBeat

Esta copia contiene la beta móvil y el servidor freemium de prueba. Ver [MOBILE.md](MOBILE.md) para el estado real, la instalación y los pendientes. El servicio publicado actualmente no fue actualizado.

**Tu ritmo, siempre.** Metrónomo sincronizado en tiempo real para bandas. El baterista controla el
tempo y todos los músicos de la sala escuchan el mismo click en su celular, con la misma fase.

- **Sala compartida:** se entra con un código o escaneando un QR.
- **Control único:** solo quien elige «Batería» puede iniciar, detener, cambiar tempo, compás o tema.
- **Cambios en la barra siguiente:** un cambio de tempo o de tema entra en el próximo compás, así el «1» nunca salta.
- **Cuenta previa:** de 0, 1 o 2 compases antes de arrancar.
- **Setlist:** el de la sala y uno propio por dispositivo. Se puede pegar desde WhatsApp o desde las notas.
- **Preparación antes de entrar:** crear setlists con nombre, guardarlos en este dispositivo y elegir uno desde la pantalla inicial.
- **Compensación visible y protegida:** el ajuste manual de latencia está bloqueado; hay que desbloquear, editar y guardar.
- **Avisos en vivo:** mensajes rápidos a toda la banda.
- **PWA:** se instala como app y tiene un modo de práctica sin conexión.

## Pendiente conocido: deriva lenta entre dispositivos

Después de unos 3 minutos tocando sin parar, dos dispositivos pueden separarse unos 10–12 ms
(medido entre dos navegadores en la misma máquina; el test `stays locked for 3 minutes` lo marca).
Está justo en el umbral donde se empieza a escuchar, y en pruebas reales de oído no se notó. No está
explicado todavía: los primeros segundos y los cambios de tempo y de tema sí quedan por debajo de
3 ms. **El umbral del test se deja en 10 ms a propósito, sin aflojarlo para que dé verde.**

## Límite conocido: la pantalla bloqueada

Con la pantalla bloqueada el click **sigue sonando**, pero los cambios de tempo y de tema **no
llegan** hasta desbloquear; al desbloquear, la app se pone al día al instante. Verificado en un
Android y un iPhone reales. Es un límite del sistema operativo con las páginas web, no del código de
sincronía: el audio se genera en cada teléfono (por eso sobrevive), pero la conexión queda suspendida.

Mientras tanto: usar «Mantener pantalla encendida» (en Ajustes de audio) y el Modo atril. La
solución de fondo requiere audio y comunicación en segundo plano con implementación nativa. Envolver la web con Capacitor por sí solo no garantiza ese comportamiento.

## Cómo funciona la sincronía

1. Cada cliente estima el desfase de su reloj respecto del servidor con pings tipo NTP, usando las muestras de menor ida y vuelta.
2. El servidor no manda clicks: manda un instante de inicio en el futuro y el tempo. Cada dispositivo programa los clicks en el reloj de Web Audio.
3. La latencia de salida del dispositivo se detecta y se compensa sola. Encima de eso, cada músico tiene un ajuste fino.
4. La estimación del reloj de audio descarta sus primeras lecturas (que llegan a estar ~170 ms
   desviadas) y reprograma los clicks aún no sonados mientras se asienta. Sin esto, los primeros
   segundos de cada tema quedaban hasta 17 ms separados entre dispositivos.

## Desarrollo

Requiere Node.js 22 o superior.

```bash
npm install
npm run dev      # http://localhost:3000 (servidor + Vite)
```

## Producción

```bash
npm install
npm run build
npm start        # sirve dist/ y el WebSocket en el puerto $PORT (por defecto 3000)
```

El servidor guarda las salas en memoria y borra las que quedan 30 minutos vacías. Para
WebSockets detrás de un proxy (Nginx, Cloudflare, etc.), habilitá el upgrade en la ruta `/api/ws`.

## Publicar en internet

`render.yaml` deja el proyecto listo para [Render](https://render.com): importás el repositorio y lo
lee solo. Sirve cualquier hosting con Node y WebSockets.

**Importante: una sola instancia.** Las salas viven en la memoria del servidor, así que con dos
instancias el baterista y el guitarrista de la misma banda podrían caer en salas distintas. Para
escalar a varias instancias hace falta mover el estado de las salas a una base compartida (Redis).

Reiniciar el servidor borra las salas activas. Las listas personales viven en cada teléfono.

## Pruebas desde celulares sin publicar

Con el servidor andando, se abre un enlace HTTPS temporal con `cloudflared`:

```bash
cloudflared tunnel --url http://127.0.0.1:3001 --no-autoupdate --protocol http2
```

El puerto debe coincidir con el del servidor. El enlace funciona mientras el servidor y el túnel
sigan activos; no es un despliegue permanente y la dirección cambia cada vez.

## Pruebas automáticas

```bash
npm run lint         # TypeScript
npm run test:unit    # motor de audio, parser de setlists, almacenamiento, reloj
npm run test:server  # protocolo WebSocket contra el servidor real
npm run test:e2e     # navegador: Chrome escritorio y móvil, y WebKit (motor de Safari)
```

`npm run test:e2e` levanta el servidor solo. Para medir la estabilidad larga:
`SYNC_MINUTES=20 npx playwright test sync`.

Las pruebas de navegador miden el audio que la app **realmente programa** en Web Audio, no el pulso
en pantalla. Verifican que dos dispositivos coloquen cada beat a menos de 10 ms (el umbral donde se
empieza a escuchar un flam), con cambios de tempo, cambios de tema, corte de internet y redes
distintas.

**Lo que las pruebas no pueden cubrir:** WebKit no es un iPhone. La sesión de audio de iOS, el
interruptor de silencio, la latencia de auriculares Bluetooth y la pantalla bloqueada solo se
verifican en un teléfono real.

La tipografía de la interfaz es Plus Jakarta Sans y se sirve desde `public/fonts`, con su licencia.

## Marca

`brand/syncrobeat-lamina.webp` es la lámina original. `scripts/brand-assets.mjs` genera desde ella
los logos e íconos de `public/` (vectoriza los trazos y aplica la paleta exacta), y
`scripts/brand-preview.mjs` arma una hoja de control en `brand/preview.png`. Si aparecen los
archivos originales del diseñador, conviene reemplazar los generados.

Paleta: `#FF3B6B` rosa, `#FF8A3C` naranja, `#FFFFFF` blanco, `#1A1A1A` carbón.
