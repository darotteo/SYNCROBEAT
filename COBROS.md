# Mercado Pago — todos los pasos

Guía para dejar listo el cobro de SyncroBeat Pro. Nada de esto se puede hacer desde el código:
son trámites y configuración en tu cuenta.

**Regla que no se rompe nunca:** las claves que dicen *Access Token* o *secret* no se pegan en un
chat, no van en archivos del proyecto y no se suben a GitHub. Van en el panel de Render como
variables de entorno, o en el archivo `.env` local (que ya está ignorado por git).

---

## 1. Crear el plan de suscripción

Estás en *Herramientas de ventas → Planes de suscripción → Crear plan*.

| Campo | Qué poner |
|---|---|
| Nombre | **SyncroBeat Pro** |
| Descripción | Toda la banda en la misma sala |
| Frecuencia | **Mensual** (cada 1 mes) |
| Moneda | Pesos argentinos |
| Precio | Ver abajo |
| Repeticiones | Sin límite |
| URL de retorno | `https://syncrobeat.online` |

### Sobre el precio

Lo charlado: el equivalente a **USD 3-4 por mes para toda la banda**, no por músico. Dividido entre
cuatro, es menos de un dólar por cabeza.

Mirá a cuánto está el dólar hoy y redondeá para arriba a un número prolijo.

**Importante:** cambiarle el precio a un plan que ya tiene suscriptores es un quilombo. Si más
adelante querés otro precio, se crea un plan nuevo y los viejos siguen con el suyo. Así que elegí
un número con el que puedas vivir un año.

### El período de prueba: NO lo configures acá

Mercado Pago ofrece poner días gratis en el plan. **No lo uses.**

Nuestro trial de 30 días arranca cuando la persona se registra en la app, no cuando se suscribe.
Son dos relojes distintos y si los dos corren, la gente termina con 60 días gratis. El trial lo
maneja SyncroBeat.

---

## 2. Crear la aplicación de desarrollador

Esto es lo que yo realmente necesito. El plan de arriba es opcional; esto no.

1. Entrá a **https://www.mercadopago.com.ar/developers/panel**
2. **Crear aplicación**
3. Nombre: **SyncroBeat**
4. Tipo de integración: **Suscripciones** (o pagos recurrentes)

Una vez creada vas a tener dos juegos de credenciales:

| | Para qué |
|---|---|
| **Credenciales de prueba** | Construir y probar todo sin un peso real |
| **Credenciales de producción** | Cobrar de verdad |

Cada juego tiene un **Public Key** y un **Access Token**.

- El *Public Key* no es secreto.
- El **Access Token sí lo es**. Ese es el que nunca se pega en ningún lado.

**Para empezar solo hacen falta las de prueba.**

---

## 3. Lo que tarda: habilitar el cobro real

Esto es entre vos y Mercado Pago, y puede llevar días. **Arrancalo ya aunque falte todo lo demás.**

En tu cuenta, fijate qué te pide para poder recibir dinero por una aplicación:

- Datos fiscales (CUIT/CUIL, condición frente a AFIP)
- CBU o cuenta donde te depositan
- Verificación de identidad

Revisá también la **comisión** que te cobra por transacción y **cuándo te liberan la plata**. En
Mercado Pago, cobrar más rápido sale más caro. Para una suscripción mensual no hay apuro: elegí la
liberación más lenta y barata.

---

## 4. Cuando tengas las credenciales de prueba

Creá un archivo llamado `.env` en la carpeta del proyecto con estas líneas:

```
MP_ACCESS_TOKEN=el-access-token-de-prueba
MP_PUBLIC_KEY=el-public-key-de-prueba
DATABASE_URL=la-cadena-de-conexion-de-neon
```

Ese archivo está ignorado por git: no se sube a ningún lado y yo no necesito leerlo.

En Render, las mismas tres van en *Settings → Environment*, pero con las credenciales de
**producción** cuando llegue el momento de cobrar de verdad.

---

## 5. Lo que hago yo

Con las credenciales de prueba cargadas:

1. La app crea la suscripción cuando alguien le da a pagar
2. Mercado Pago avisa por webhook cada vez que un pago entra, falla o se cancela
3. La cuenta se habilita o se da de baja sola, sin que vos toques nada

Se prueba entero con tarjetas de prueba que da Mercado Pago, sin plata real.

---

## Resumen de qué hacer y en qué orden

| | Qué | Cuánto tarda |
|---|---|---|
| 1 | Empezar el trámite para cobrar de verdad (datos fiscales, CBU) | **Días** — arrancá ya |
| 2 | Crear la aplicación de desarrollador | 5 minutos |
| 3 | Copiar las credenciales de **prueba** al `.env` | 1 minuto |
| 4 | Crear el plan de suscripción | 5 minutos, se puede después |

El 1 es el único que no se puede apurar. Todo lo demás se hace en un rato.
