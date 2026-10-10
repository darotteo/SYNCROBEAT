# SYNCROBEAT móvil — beta 1.1.0

Esta copia parte del commit `f8ed2fe8e0eb1d5c87eea6de518d19426696fc88`. El repositorio original y el servicio actual de Render no fueron modificados ni publicados. Es una beta para probar la instalación, no una versión final con cobros.

## Qué está preparado

- Proyectos Android e iOS con Capacitor 8, aplicación `com.darotteo.syncrobeat.beta`, nombre **SyncroBeat Beta**.
- Recursos web incluidos en la aplicación: la práctica individual puede abrirse sin descargar la página.
- Conexión HTTPS/WSS al servidor configurable, compartir y copiar enlaces con las funciones del teléfono.
- Mantener la pantalla encendida mediante una función nativa mientras estás en una sala, según el ajuste existente. Esto evita depender de la API del navegador; no mantiene la aplicación trabajando con la pantalla bloqueada.
- Servidor de esta copia: **dos personas en total por sala gratuita, incluido el baterista**. La tercera recibe un mensaje y no ocupa un lugar. Una reconexión del mismo dispositivo conserva su lugar.
- Credencial privada por dispositivo y servidor. El identificador que aparece en la lista de músicos ya no alcanza para reemplazar al baterista. Una conexión no puede cambiar su identidad y dejar un baterista fantasma.
- El motor `src/utils/audioEngine.ts` se conserva idéntico al original. Los casos de cambios rápidos de tempo y demora al silenciar siguen pendientes del informe anterior.
- Los nuevos setlists usan identificadores UUID, con un contador de respaldo. Una prueba de creación masiva detectó una colisión en el generador anterior; las listas ya guardadas conservan sus identificadores.

## Qué servidor usa el primer APK

El APK inicial se compila con `https://syncrobeat.onrender.com`, la dirección que compartiste. Sirve para probar la aplicación contra tu servicio actual. **Ese servidor todavía conserva su funcionamiento anterior: el límite de dos personas y la protección nueva no se activan con solo instalar el APK.**

La pantalla muestra el texto del límite únicamente cuando el servidor anuncia que lo aplica. La consulta previa del rol de batería requiere que el servidor permita los orígenes nativos; el servidor actual puede impedir esa consulta. La conexión WebSocket y la validación al entrar siguen siendo responsabilidad del servidor.

Para probar freemium completo, publicar **un servicio nuevo** desde esta copia con `render.beta.yaml`, obtener su dirección y volver a compilar el APK apuntando a ella. El archivo está preparado, pero no fue enviado a Render ni ejecutado. El plan gratuito puede suspenderse por inactividad; no garantiza disponibilidad para ensayos largos.

## Prueba Pro sin cobros

En el servidor de beta, `SYNCROBEAT_RELEASE_CHANNEL=beta` y `BETA_PRO_ROOM_CODES=PRO-TEST` habilitan más de dos personas en esa sala. La concesión viene de una variable del servidor; no se acepta un supuesto pago enviado por el cliente. Fuera del canal beta se ignora esa lista.

Este mecanismo es solo de prueba. **No hay compras, suscripciones, restauración ni verificación de pagos implementadas.** Para la versión comercial falta asociar la compra al anfitrión/baterista y verificar su derecho Pro en el servidor. No se definieron precio ni periodicidad.

## Compilar Android

Requisitos: Node 22.12 o superior, JDK 21 y SDK Android con plataforma 36 y herramientas de compilación 36.0.0. Capacitor documenta el entorno en su [guía oficial](https://capacitorjs.com/docs/getting-started/environment-setup).

```powershell
npm ci
$env:VITE_SYNCROBEAT_API_URL='https://syncrobeat.onrender.com'
$env:VITE_SYNCROBEAT_SHARE_URL='https://syncrobeat.onrender.com'
npm run mobile:sync
cd android
.\gradlew.bat assembleDebug --no-daemon
```

También podés crear `.env.mobile.local` con esas dos variables. La dirección debe ser solo el origen HTTPS, sin `/?room=...`. El SDK debe estar indicado en `android/local.properties` o `ANDROID_HOME`. Las claves de firma y las rutas locales se excluyen de Git.

Salida: `android/app/build/outputs/apk/debug/app-debug.apk`. Es una firma de pruebas; no sirve para publicar en Google Play. Android mínimo: 7.0 (API 24). La aplicación beta usa una identidad diferente de la futura publicación.

Para actualizar una beta ya instalada, conservar la misma clave de firma. Cambiarla puede exigir desinstalar la aplicación y perder sus datos locales. La clave de prueba usada aquí se guarda fuera del paquete de código, en `work/beta-debug.keystore`; no es una clave de distribución.

## iPhone sin tener una Mac

El proyecto iOS está generado con Swift Package Manager, pero no fue compilado en Windows. Para una app instalable hace falta Xcode en una Mac local o un servicio de compilación con Mac, una firma válida y acceso a la cuenta de Apple. Para distribuir a probadores mediante TestFlight, falta configurar el equipo y App Store Connect. [Requisitos de Capacitor](https://capacitorjs.com/docs/getting-started/environment-setup), [TestFlight de Apple](https://developer.apple.com/testflight/).

El flujo manual `.github/workflows/mobile-beta.yml` prepara un APK y un chequeo de compilación iOS en una máquina Mac de GitHub. **No fue ejecutado ni subido a GitHub. El chequeo iOS desactiva la firma y no produce una app instalable.** No sustituye TestFlight ni configura tu cuenta Apple.

## Prueba en los teléfonos

1. Instalar el APK en Android y abrir **SyncroBeat Beta**. Las listas del navegador no se copian automáticamente: usar la exportación/importación existente si hace falta.
2. Abrir la misma sala en la compu y el celular; elegir batería en un dispositivo y guitarra/bajo en el otro.
3. Probar iniciar, detener, cambiar tema, compartir, cerrar y volver a abrir, salir y volver a entrar y practicar en modo avión.
4. Mantener la pantalla encendida durante el ensayo. Probar aparte cambio de red, Bluetooth, llamadas y bloqueo; esas pruebas físicas todavía no se realizaron con el APK.
5. Cuando exista el servidor de beta separado, entrar con dos personas a una sala gratuita y comprobar el rechazo de una tercera. Probar tres personas en `PRO-TEST`.

## Antes de llamar a esto versión final

- Completar compras y restauración, validación de pagos, vencimientos y persistencia de los derechos Pro. Las reglas para bienes digitales están en [Apple](https://developer.apple.com/app-store/review/guidelines/#in-app-purchase) y [Google Play](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en), con excepciones según región/programa.
- Validar el audio y la sincronía en Android e iPhone físicos, incluidos cambios rápidos de tempo y silenciar/reactivar.
- Implementar y probar el audio y la comunicación de sala en segundo plano si se quiere admitir pantalla bloqueada. Empaquetar la web en Capacitor no garantiza ese comportamiento. En Android, consultar la [reproducción en segundo plano](https://developer.android.com/media/media3/session/background-playback).
- Preparar firmas de distribución, cuentas de tiendas, privacidad, fichas y revisión. Los enlaces HTTPS actuales abren la web; todavía no se configuraron enlaces universales/App Links para abrir la app automáticamente.
