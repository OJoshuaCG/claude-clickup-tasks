# claude-clickup-tasks

Protocolo de gestión de tareas de ClickUp para Claude Code, **instalado una vez y global a toda
la máquina**.

Resuelve dos cosas concretas:

1. **Que dos personas no hagan el mismo trabajo.** Antes de escribir la primera línea de código,
   Claude valida contra el tablero compartido si esa tarea ya existe, si alguien la está haciendo
   ahora, o si ya se hizo. Si está tomada, **para y avisa quién la tiene**.
2. **Que no haya que copiar y pegar a mano.** Claude crea la tarea, la asigna, le pone fechas y
   prioridad, comenta el inicio y el cierre. El desarrollador se concentra en programar.

---

> **Sobre los ejemplos de este documento:** todos los nombres, correos e ids son
> **ficticios**. Los dominios (`example.com`, `example.net`, `acme.example`) están reservados por
> RFC 2606 para documentación y no pueden existir como dominios reales; los ids usan rangos
> sintéticos. No hay ningún dato de un tablero real acá — reemplazalos por los tuyos.

---

## Por qué global y no por proyecto

La versión anterior de esto vivía dentro de cada repositorio: una copia de la skill, del hook y
del comando en cada uno. Eso tenía tres problemas, y el tercero es el que duele:

- **Instalación manual repo por repo.** Un proyecto nuevo arrancaba sin protocolo hasta que
  alguien se acordara de copiar los archivos.
- **Archivos del protocolo dentro del repo del producto**, con su entrada en `.gitignore` y su
  ruido en cada `git status`.
- **Las tres copias se desincronizaron.** Y no en detalles: llegaron a **contradecirse sobre en
  qué campo va la fecha de fin** y **sobre a quién se le asigna una tarea**. Dos copias decían
  una cosa, la tercera lo prohibía explícitamente. Cuando el protocolo vive en tres lugares, tres
  personas lo corrigen en tres direcciones distintas.

Acá el protocolo vive en **un** lugar y se **resuelve por proyecto** en tiempo de ejecución.

---

## Instalación

Necesitás Claude Code y node 18+. **node no es una dependencia extra**: Claude Code se distribuye
como paquete de npm, así que si Claude Code funciona en esa máquina, node está.

### Linux, macOS, WSL, Git Bash

```bash
git clone <url-del-repo> claude-clickup-tasks
cd claude-clickup-tasks
./install.sh
```

### Windows (PowerShell)

```powershell
git clone <url-del-repo> claude-clickup-tasks
cd claude-clickup-tasks
.\install.ps1
```

El instalador es una TUI que pregunta cuatro cosas y cada una tiene default (se contesta todo con
Enter):

| Pregunta | Para qué |
| --- | --- |
| Tu email o usuario de ClickUp | Resolver **tu id numérico**, que es a quien se asignan las tareas |
| ¿Fechas de inicio y fin? | Registrar cuándo arrancó y cuándo se entregó cada trabajo |
| ¿Prioridades? | Fijar prioridad al crear, por criterio de impacto |
| ¿Autoasignar a tu usuario? | Que quien crea o reclama quede asignado |

Y dos más que conviene leer antes de contestar: **dónde va la fecha de fin** (ver
[la decisión sobre `due_date`](#3-la-fecha-de-fin-no-va-en-due_date-por-default)) y si se activa
**el candado**.

> **WSL y Windows son dos instalaciones distintas.** Cada uno tiene su propia carpeta de
> configuración de Claude Code (`~/.claude` en WSL, `C:\Users\<vos>\.claude` en Windows). Instalar
> en una no instala en la otra. Si usás los dos, corré el instalador en los dos — el propio
> instalador te avisa cuando detecta la otra.

### Plataformas probadas

Los quince suites (460 tests) corren y pasan en las dos, y la instalación completa
—instalar → configurar → candado → desinstalar— se ejecutó de verdad en cada una:

| | Estado |
| --- | --- |
| **Linux / WSL2** (node 22.22) | ✅ 460/460 · `install.sh` end-to-end |
| **Windows 11** (node 22.13, PowerShell 5.1) | ✅ 460/460 · `install.ps1` end-to-end |
| macOS | Sin probar. No debería haber diferencia con Linux (mismo `install.sh`, mismo node), pero no está verificado |

Detalles que Windows obliga a manejar y están cubiertos por tests:

- Los hooks se registran con **rutas absolutas en forward-slash** (`node "C:/Users/…/cli.mjs" guard`),
  que funcionan en `cmd`, PowerShell y `sh`.
- La clave de un proyecto normaliza la **letra de unidad a minúscula** y colapsa separadores
  repetidos, así que `C:\Users\p` y `c:/Users//p` son la misma entrada y no dos.
- Se escriben **dos wrappers** (`clickup-flow` para sh, `clickup-flow.cmd` para Windows) y la
  desinstalación se lleva los dos.
- Rutas UNC (`\\servidor\share\proyecto`) conservan su `//` inicial.

### Qué toca, exactamente

```
~/.claude/
├── clickup-flow/              ← nuevo: motor, configuración, estado y backups
│   ├── src/
│   ├── config.json            ← tu configuración (esto es lo que sobrevive a todo)
│   ├── state/
│   └── backups/
├── skills/clickup-task-flow/  ← nuevo
├── commands/                  ← nuevo: tarea.md, clickup-setup.md, clickup-config.md
└── settings.json              ← MODIFICADO: se agregan 3 hooks y permisos de lectura
```

**`settings.json` se modifica por unión, nunca por reemplazo.** Se hace un backup con timestamp
antes de escribir, tus hooks y tus permisos se conservan tal cual, y reinstalar **reemplaza** las
tres entradas propias en vez de acumularlas. Está cubierto por tests: el suite arranca con un
`settings.json` realista —con hooks de otras herramientas y listas de `allow`/`deny`— y verifica
que después de instalar, reinstalar y desinstalar **no falte nada de lo que había**.

```bash
npm test                  # 460 tests, en un CLAUDE_CONFIG_DIR desechable
```

Quince suites, y la mayoría son **adversariales**: no prueban que funcione con entrada válida,
prueban que **con entrada inválida no borre nada y no explote**. `npm test` los descubre del
directorio `test/`, así que agregar uno no requiere acordarse de anotarlo en ninguna lista.

| Suite | Qué cubre |
| --- | --- |
| `paths` | Canonicalización de rutas: Windows, UNC, WSL, separadores repetidos |
| `run` | Instalación, merge de settings, candado, protocolo, estados, migración |
| `flujo` | El recorrido completo de punta a punta, con coordenadas ficticias |
| `ciclo-vida` | Instalar → reinstalar → **actualizar a otra versión** → desinstalar |
| `adversarial-settings` | `settings.json` con formas inválidas en cada nivel, BOM, unicode |
| `adversarial-estado` | Timestamps imposibles, config corrupto, hermanos con prefijo común |
| `adversarial-identidad` | Matcheo de miembros y tokens: quién recibe el trabajo |
| `adversarial-protocolo` | Render con configuración hostil, cajas y wrapping |
| `adversarial-migracion` | Escaneo del protocolo viejo e importación del equipo |
| `adversarial-cli` | Entradas hostiles a los tres hooks, parseo de argumentos, `project forget` |
| `concurrencia` | 20 procesos escribiendo el config a la vez; encontró un lost update real |
| `hostilidad` | Permisos, symlinks, nombres con comillas, payloads de 5 MB, cwd borrado |
| `esquema` | 90 combinaciones de tipo equivocado + 192 combinaciones del protocolo |
| `idempotencia` | Cada comando tres veces, y los 14 caminos de error uno por uno |
| `instrucciones` | Que el skill y los comandos no pierdan sus reglas, y coincidan con la API |

---

### El comando `clickup-flow`

Los ejemplos de este README usan `clickup-flow` por legibilidad. **El instalador no toca tu PATH
ni tus archivos de shell** — eso es tuyo, y un instalador global no tiene por qué reescribirlo.
Tenés dos formas, y las dos son válidas:

```bash
# 1. La ruta completa: funciona siempre, sin configurar nada
node "$HOME/.claude/clickup-flow/src/cli.mjs" doctor

# 2. Un alias, si vas a usarlo a mano seguido (el instalador imprime esta línea al terminar)
alias clickup-flow='node "$HOME/.claude/clickup-flow/src/cli.mjs"'
```

En PowerShell:

```powershell
Set-Alias clickup-flow "$env:USERPROFILE/.claude/clickup-flow/clickup-flow.cmd"
```

**Nada de esto le hace falta a Claude.** La skill y los comandos se instalan con la **ruta completa
ya sustituida**, precisamente para que el protocolo no dependa de que un nombre corto esté
disponible: un comando que existe en la máquina donde se instaló y falta en la siguiente fallaría
en silencio, y el síntoma sería "el protocolo no hizo nada".

---

## Cómo funciona

Tres hooks que ejecuta **el harness de Claude Code, no el modelo**. Esa distinción es el punto:
una instrucción se puede olvidar o diluir cuando el contexto se comprime en una sesión larga; un
hook no.

| Hook | Cuándo | Qué hace |
| --- | --- | --- |
| `SessionStart` | Al abrir sesión | Anuncia a qué espacio de ClickUp está atado el proyecto, o que no tiene ninguno |
| `UserPromptSubmit` | En cada turno | Recuerda si hay tarea reclamada y qué falta hacer |
| `PreToolUse` | Antes de cada `Edit`/`Write` | **Cancela la escritura** si no hay tarea reclamada ni exención vigente |

### El candado falla ABIERTO cuando no está configurado

Es lo más importante de una instalación global: los hooks corren en **todos** los repositorios de
la máquina, incluidos los que no tienen nada que ver con ClickUp. Un candado que se active ahí
convertiría una comodidad en algo que rompe trabajo ajeno.

Así que el `PreToolUse` deja pasar, sin decir nada, cuando:

- el proyecto **no está configurado**;
- el proyecto está **excluido** a propósito;
- el candado está apagado en la configuración;
- hay una **tarea reclamada**;
- hay una **exención vigente**;
- lo que se edita es `CLAUDE.md` o algo dentro de `.claude/` (configurar el tooling no es el
  trabajo compartido que el candado protege);
- **la configuración no se puede leer.** Un JSON roto desactiva el protocolo, no la máquina.

Solo bloquea en el caso restante: proyecto configurado, candado activo, y ni tarea ni exención.

**Límite conocido, dicho sin adornos:** cubre las herramientas de edición. Una escritura hecha por
`Bash` (heredoc, `sed`, `tee`) **no pasa por el hook**. Es un candado fuerte, no hermético.

### Un solo protocolo, resuelto por proyecto

La skill que lee Claude es genérica y **no contiene coordenadas**. Lo primero que hace es correr:

```bash
clickup-flow context
```

y eso imprime, para el directorio donde está parado: el espacio y la lista reales, el modo de
trabajo, **el id numérico al que hay que asignar**, qué campos usa el proyecto, dónde va la fecha
de fin, y si hay una tarea reclamada ahora mismo.

Por eso no hay copias que mantener sincronizadas: hay una fuente y una resolución.

---

## El flujo de trabajo

```
El usuario abre un proyecto nuevo
        │
        ▼
¿Esta carpeta ya tiene espacio de ClickUp?
        │
   ┌────┴─────┐
  NO          SÍ ──────► el protocolo aplica, con las reglas de ESE proyecto
   │
   ▼
/clickup-setup  ─── lista los espacios y pregunta:
   │                 · ¿en qué espacio y lista viven las tareas?
   │                 · ¿varias tareas normales, o una principal con subtareas?
   │                 · ¿o este proyecto queda excluido?
   ▼
Se registra la respuesta ── incluida la exclusión, que también se guarda
                            para no volver a preguntar nunca
```

Un proyecto excluido no vuelve a preguntar y **no genera ruido en ningún hook**: silencio total.
Si el usuario cambia de opinión, `/clickup-setup` lo reactiva — pero solo si lo pide él.

### El rol: quién entrega a quién

`mode` dice **cómo se ve** el proyecto en el tablero. `role` dice **hacia dónde entrega**, y es lo
que hace que el handoff reserve algo de verdad.

| Rol | Contraparte | Al cerrar | Bandeja de entrada |
| --- | --- | --- | --- |
| `fullstack` | — | siempre cierra | sus propias tareas |
| `backend` | registrada | puede dejar en el estado de handoff si toca el contrato | el backlog + pedidos detenidos |
| `backend` | **no registrada** | **siempre cierra** | el backlog |
| `frontend` | da igual | siempre cierra: es el final de la cadena | **el estado de handoff**, no `to do` |

**La tercera fila es la que importa.** Un `backend` sin contraparte que parkea una tarea en el
estado de handoff la deja esperando a **nadie**: no hay quien mire ese filtro, y la tarea *parece*
entregada. Antes de tener el rol, el protocolo decía *"si dudás, va al estado de handoff"* incluso
sin contraparte — o sea, perdía la tarea con apariencia de éxito.

**Un `frontend` puede pedirle trabajo al backend exista o no su repositorio.** La asimetría es
deliberada: parkear en el estado de handoff exige que alguien vigile ese filtro, mientras que una
tarea detenida con el pedido escrito la encuentra cualquiera. El pedido es a una persona, no a un
repositorio.

```bash
clickup-flow project set … --role backend --counterpart /ruta/al/frontend
clickup-flow project set … --role frontend --counterpart /ruta/al/backend
clickup-flow project set … --role fullstack
clickup-flow project set … --counterpart none    # quitar la contraparte
```

`role` y `mode` son **ortogonales**: podés tener un backend con tareas normales o un backend con
paraguas.

### Un estado del tablero no le veta el trabajo a nadie

Cuando el protocolo encuentra que el trabajo **ya está tomado o ya se hizo**, eso **no cancela
nada**. La herramienta existe para que nadie duplique *por accidente*, no para negar trabajo por un
estado en un tablero — y el usuario suele tener el contexto que falta: sabe que la otra persona no
está, que es urgente, o que en realidad es otra tarea que se parece.

**Se plantea una vez, con las tres salidas, y decide el usuario:**

| Opción | Qué pasa |
| --- | --- |
| **No es la misma tarea** | Tarea nueva, vinculada a la que se encontró. **El caso más frecuente** |
| **Sí es la misma, y la hago igual** | Se suma a los asignados y deja un comentario `TRABAJO EN PARALELO` con `notify_all` |
| **No la hago** | Para, y dice a quién escribirle |

Con la respuesta se procede, **y no se vuelve a plantear**. Repetir la advertencia cada turno es
exactamente lo que hace que la gente deje de leerla.

Lo único que no es opcional si elige seguir: el comentario con notificación. Es lo que evita que la
otra persona descubra el trabajo duplicado en el merge.

### Los dos modos

| Modo | Cómo se ve en el tablero | Cuándo |
| --- | --- | --- |
| `tasks` | Cada trabajo es una **tarea normal** en la raíz de la lista. Las subtareas son la excepción | Proyecto de larga vida, trabajo variado, tablero compartido con más gente |
| `umbrella` | Hay una **tarea paraguas** y cada trabajo es una **subtarea** suya | Iniciativa acotada que querés ver como una sola unidad |

### Los comandos

| Comando | Qué hace |
| --- | --- |
| `/tarea <descripción>` | Decide si amerita tarea, valida contra el tablero, la crea o la reclama |
| `/tarea fin <id>` | Cierra: `complete` o handoff, con el comentario de cierre |
| `/tarea pausa <motivo>` | `on hold` diciendo dónde quedó. Nunca se deja en `in progress` |
| `/tarea estado` | Qué está en curso, quién lo tiene, qué está libre, y colisiones ya ocurridas |
| `/tarea handoff` | Lo que espera trabajo del otro rol |
| `/tarea bloqueos` | Las `on hold` con un pedido concreto adentro — no salen en ningún filtro habitual |
| `/clickup-setup` | Configura (o excluye, o reactiva) **este** proyecto |
| `/clickup-config` | Identidad, preferencias globales, proyectos registrados, diagnóstico |

---

## Las decisiones que se tomaron

Los tres proyectos de origen se contradecían en cuatro puntos. No se podía "juntar todo": había
que elegir, y el criterio fue cuál de las dos versiones era verificablemente correcta.

### 1. `"me"` está prohibido como assignee — este era el bug

**El síntoma reportado: "a veces no asignaba las tareas correctamente".**

`clickup_resolve_assignees(["me"])` devuelve el **dueño del token de la integración**, no la
persona que está ejecutando. Dos de los proyectos lo usaban; el tercero lo prohibía
explícitamente y mantenía una tabla de equivalencias a mano.

En equipo, `"me"` le asigna **todas** las tareas a la misma persona. No falla, no avisa, y se
descubre semanas después cuando alguien filtra el tablero por asignado.

**Resolución:** el instalador resuelve tu **id numérico** una vez y lo guarda confirmado.
`"me"` no se usa nunca, y `identity set` **rechaza** cualquier valor que no sea numérico.

Y el detalle que lo hacía difícil: **el email de git no resuelve contra ClickUp.** Es normal que
la cuenta del tablero esté en un dominio corporativo y los commits vengan de un gmail. Así que hay
dos identidades y cada una tiene su uso:

| Para qué | Qué se usa |
| --- | --- |
| Escribir en los comentarios (detectar colisiones) | El **email de git** |
| Asignar la tarea | El **id numérico** de ClickUp |

La identidad va **dentro del texto** del comentario porque todos los comentarios se publican con
la cuenta del token: el campo "autor" de ClickUp es inútil para detectar colisiones.

### 2. `assignees` se lee, se une y se escribe

`clickup_update_task.assignees` recibe la **lista completa** y no tiene `add`/`rem`. Mandar solo
tu id sobre una tarea que ya tenía dos asignados **borra a esas dos personas**, en silencio.

Los tres proyectos ya coincidían en esto. Se conserva, y el protocolo lo repite donde hace falta.

### 3. La fecha de fin NO va en `due_date` por default

Acá la contradicción era total: dos proyectos escribían la fecha de fin en `due_date`; el tercero
lo **prohibía**, con un motivo verificado — su equipo usa `due_date` como **fecha límite real**,
y hay tareas cerradas antes y después de la suya. Escribir ahí la fecha de fin **borra el
vencimiento que puso otra persona**, sin forma de recuperarlo.

**Resolución:** el default es `description` (línea `**Finalizado:** YYYY-MM-DD` + el `date_closed`
que ClickUp estampa solo, que ya es exacto). `due_date` no se toca.

**Y es configurable por proyecto**, porque los dos repos que ya tienen datos en `due_date` no
pueden cambiar de criterio retroactivamente. Ver [overrides](#overrides-por-proyecto).

### 4. Las tres fechas, y la ventana de búsqueda

Del tercer proyecto se adoptaron dos ideas que a los otros dos les faltaban:

- **Tres fechas distintas, no dos.** `date_created` lo estampa el servidor y **no se puede
  definir por API**, así que si el usuario pidió algo el lunes y la tarea se crea el miércoles, la
  fecha real se pierde. Por eso la **solicitud** va como línea en la descripción, el **inicio** en
  `start_date` (al reclamar, no al crear), y el **fin** solo al pasar a `complete`.
- **La ventana de búsqueda es escalonada.** Lo **abierto** se busca sin límite de fecha; lo
  **cerrado** y la búsqueda por texto, en una ventana (30 días por default). `on hold` y
  `update required` **nunca** se acotan: es trabajo parado esperando a alguien, y acotarlo lo
  volvería invisible justo cuando más falta hace.

El precio, dicho claro: una tarea cerrada hace más de 30 días no aparece, así que se puede rehacer
trabajo muy viejo. Es un intercambio deliberado — paginar cientos de tareas antiguas se paga en
**cada** reclamo.

### 5. Los nombres de los estados se capturan, no se asumen

Esto no venía de los tres proyectos: salió de verificar el tablero real y darse cuenta de que la
herramienta tenía un agujero.

El protocolo escribe `status: "in progress"`, `status: "complete"`. Esos nombres son los del
espacio Acme — pero **un espacio puede llamar a sus estados como quiera**. Si se llaman
`En progreso` y `Terminado`, cada `clickup_update_task` falla, y el síntoma que ve el usuario es
"el protocolo no hizo nada". Para una herramienta que se instala en cualquier proyecto, eso es un
bug.

Ahora `/clickup-setup` lee los estados reales con `clickup_get_list`, los mapea contra los cinco
roles que el protocolo necesita (libre, en curso, detenida, handoff, cerrada) y los guarda por
proyecto. `context` emite **esos** nombres. Los estados que sobran quedan declarados como *sin
significado en este flujo*, y el protocolo manda preguntar antes de asumir.

Y `project set` valida: si mapeás un estado que no está en la lista, **falla ahí** en vez de
dejarte descubrirlo en el primer update que no anda.

### 6. Dos afirmaciones heredadas que estaban mal, y se corrigieron

Las skills originales decían que estos puntos estaban "verificados contra la API". Al medirlos
contra un tablero real, dos no eran exactos:

**`date_closed` solo lo estampa `type: closed`, no `type: done`.** Los estados de ClickUp tienen
un `type`. En Acme, `complete` es `type: closed` y `reviewed` es `type: done`: los dos cierran
la tarea en la UI, pero **`reviewed` deja `date_closed` en `null`**. Por eso la fecha de fin nunca
se deja únicamente a ese campo, y por eso al mapear el rol "cerrada" conviene elegir uno de tipo
`closed`.

**`date_closed_from` no filtra estrictamente por fecha.** Devuelve las tareas del **grupo cerrado**
incluso cuando tienen `date_closed: null` — se comprobó con una tarea en `reviewed` que apareció en
una consulta acotada a 30 días teniendo `date_closed` nulo. Lo que sí hace, y es lo que importa, es
**excluir todo lo abierto**: por eso la regla de "nunca lo pongas en la búsqueda principal" era
correcta, aunque el motivo estuviera mal explicado.

### 7. El estado dejó de vivir dentro del repo

Los tres proyectos guardaban el claim en `.claude/.tarea-actual`, dentro del checkout. Ahora vive
en `~/.claude/clickup-flow/state/`. **La herramienta no escribe nada en tus repos** salvo que le
pidas explícitamente la nota en el `CLAUDE.md`.

---

## Lo que se consideró y se descartó

Está acá para que nadie tenga que adivinar si algo se pasó por alto o se decidió.

**Cubrir las escrituras por `Bash`.** El candado intercepta `Edit`/`Write`/`MultiEdit`, no un
`sed -i` ni un heredoc. Se evaluó un hook `PreToolUse` sobre `Bash` que buscara patrones de
escritura (`>`, `tee`, `sed -i`). **Descartado:** la tasa de falsos positivos es alta —`grep`,
`cat`, un build que escribe artefactos— y bloquear trabajo legítimo en todos los repos de la
máquina es peor que el hueco que tapa. Queda documentado como límite: es un candado fuerte, no
hermético, y saltearlo a propósito por Bash es violar el protocolo, no un resquicio.

**Asignar tags.** El tablero **sí** usa tags (`backend`, `whatsapp`, `frontend`, `ai`, `agentes`…).
Se podrían inferir de las tareas existentes. **Descartado, igual que en el protocolo original:** no
hay herramienta MCP para listar los tags de un espacio, y `clickup_add_tag_to_task` falla si el tag
no existe. Habría que deducirlos y acertarle al criterio de otra persona; un tag mal puesto ensucia
los filtros de todo el equipo. Los pone quien quiera, a mano.

**Sincronizar `TODO.md`.** Tus tres repos usan un `TODO.md` como espejo del detalle.
**Descartado:** automatizarlo significa escribir dentro de tus repos —lo contrario de la decisión
de sacar el estado de ahí— y los tres formatos son distintos. La herramienta **no lo toca ni lo
reemplaza**: si tu flujo lo usa, seguí manteniéndolo como hasta ahora.

**Distribuir como plugin de Claude Code** (`claude plugin install`). **Descartado por ahora:**
exige publicar un marketplace o repo público, y un plugin no hospeda tan bien un archivo de
configuración editable a mano con el registro de proyectos. Si más adelante lo quieren para el
equipo, el contenido de `assets/` ya está en la forma que un plugin necesita.

**Resolver la identidad sin intervención humana.** Se podría rankear el mejor candidato por
parecido de nombre. **Descartado:** es justo el error que la herramienta existe para eliminar. Un
parecido de apellido no es evidencia, y una asignación silenciosa al colega equivocado se descubre
semanas después. Si hay ambigüedad, decide el humano.

**Hacer `exemption_hours` y el candado configurables por proyecto.** **Descartado:** son
propiedades de la persona y de la máquina, no del tablero. Solo se pueden overridear por proyecto
las cinco cosas que de verdad cambian entre tableros.

**Detectar que `/mnt/c/...` y `C:\...` son la misma carpeta** (WSL y Windows). **Descartado a
propósito:** son dos instalaciones distintas de Claude Code, con dos `settings.json` y dos
`config.json`. Cada una necesita su propia entrada, y hay un test que lo fija. El instalador avisa
cuando detecta la otra.

---

## Configuración

Un archivo, `~/.claude/clickup-flow/config.json`, pensado para leerse y editarse a mano. Escribirlo
**nunca descarta claves que no conoce**, así que podés agregarle campos propios.

```json
{
  "identity": {
    "clickup_user_id": "5000000001",
    "clickup_email": "atorres@acme.example",
    "confirmed": true,
    "git_emails": ["ana.torres@example.net", "atorres@dev.example"]
  },
  "defaults": {
    "use_dates": true,
    "use_priorities": true,
    "auto_assign": true,
    "end_date_field": "description",
    "search_window_days": 30,
    "block_writes_without_task": true,
    "exemption_hours": 8
  },
  "projects": {
    "/home/alex/code/mensajeria-api": {
      "name": "mensajeria-api",
      "mode": "tasks",
      "space_id": "2000000001",
      "list_id": "4000000001",
      "handoff": true,
      "git_remote": "github.com/acme/mensajeria-api"
    }
  },
  "team": {}
}
```

**`git_emails`** es la lista de emails que son *vos*. Sirve para que un `INICIO` hecho desde otra
máquina tuya no se lea como la colisión de un compañero. Se aprende sola cada vez que reclamás.

**`git_remote`** hace que un segundo clone del mismo repo herede la configuración en vez de volver
a preguntar.

### La ventana de búsqueda (`search_window_days`)

Antes de crear una tarea, el protocolo busca si ya existe. **Lo que está abierto se busca siempre
completo**, sin límite de fecha — incluido lo que espera a otra persona, porque un handoff de hace
tres meses sigue siendo un handoff pendiente. Eso no se configura.

Lo que se acota es lo **cerrado**, y el intercambio es real en las dos direcciones:

| Valor | Qué pasa |
| --- | --- |
| `7`–`15` | Búsquedas baratas, pero una tarea cerrada hace más tiempo no aparece y se puede rehacer trabajo viejo |
| `30` | El default |
| `90`, `365` | Se escapa menos; cada reclamo pagina más |
| **`0`** | **Sin límite.** El protocolo **quita el filtro de fecha** y pasa de tres pasadas a dos, porque `include_closed: true` sin filtro ya trae todo |

**Con un tablero chico, `0` es la mejor opción**: es barato y no se pierde nada. Con cientos de
tareas cerradas, acotar empieza a valer la pena.

Se pregunta en la instalación, y se cambia después en cualquier momento:

```bash
clickup-flow config set --key defaults.search_window_days --value 90    # global
clickup-flow config set --key defaults.search_window_days --value 0     # sin límite
clickup-flow project set … --search-window-days 15                      # solo este proyecto
```

`clickup-flow status` te dice cuál está en efecto (`cerradas 15d` o `cerradas sin límite`), y marca
si viene de un override del proyecto.

### Overrides por proyecto

Estos cinco campos se pueden definir por proyecto, y ganan sobre el default global:

```
use_dates · use_priorities · auto_assign · end_date_field · search_window_days
```

```bash
clickup-flow project set --mode umbrella --list-id … --end-date-field due_date
```

Existen porque la misma máquina necesita respuestas distintas por tablero. Lo demás —la identidad,
el candado— es propiedad de la persona y de la máquina, no del tablero, y se queda global.

---

## Migrar los tres proyectos actuales

> ⚠️ **La configuración vieja SÍ hay que quitarla, y no es cosmético.** Las skills y los comandos
> de proyecto **ganan** sobre los globales. Y el `CLAUDE.md` de mensajeria dice textualmente *"Si hay
> otra skill de ClickUp cargada (por ejemplo una global de la cuenta), **gana esta**"*. Esa frase
> sola alcanza para que el agente siga el protocolo viejo —con `"me"` como assignee, o sea el bug—
> aunque ya hayas instalado esto.

### 0. Ver qué hay que limpiar

Corré esto **dentro de cada repo**. No borra nada: detecta, explica por qué cada cosa molesta, y
te da el comando exacto.

```bash
clickup-flow migrate
```

En tus tres repos va a encontrar seis conflictos: la skill del repo, el `/tarea` del repo, los dos
hooks, las entradas de `hooks` en el `settings.json` del repo, y el `CLAUDE.md`. Los dos últimos
los marca como **a mano**, porque son archivos donde hay más cosas que no hay que tocar.

Y el mapeo del equipo lo trae con un comando:

```bash
clickup-flow migrate --import-users
```

Preserva `confirmado: false` y la nota que explica por qué — si una entrada existía sin nota, la
**completa** en vez de saltearla. `confirmed` se combina de forma conservadora: si alguna de las dos
fuentes dice "sin validar", el resultado es "sin validar". Nunca se promueve solo, y no borra el
archivo original.

### 1. Registrar los proyectos

> ⚠️ **Todos los ids, nombres y emails de este README son FICTICIOS.** Los dominios salen de
> RFC 2606 (`example.com`, `.example`), que están reservados para documentación y no pueden
> existir; los ids usan rangos sintéticos que ningún workspace real produce. Reemplazalos por los
> tuyos — y no los pegues en el repositorio: sacá los tuyos con `clickup_get_workspace_hierarchy`
> y `clickup_get_list`, y si querés tenerlos a mano, guardalos en un archivo local que el
> `.gitignore` ya excluye (`MIGRACION.local.md`).

Ajustá los ids y las rutas, y corré cada bloque **dentro de su carpeta**.

Los estados del ejemplo son los nombres canónicos que suele traer una lista:
`to do` · `on hold` · `in progress` · `update required` · `reviewed` (type `done`) ·
`complete` (type `closed`). **Los tuyos pueden llamarse distinto: leelos con
`clickup_get_list`,** que es justo lo que hace `/clickup-setup`.

```bash
# ---- mensajeria-api — varias tareas normales, sin paraguas -----------------------------------
cd /ruta/a/mensajeria-api
clickup-flow project set \
  --mode tasks --name "mensajeria-api" \
  --workspace-id 1000000001 \
  --space-id 2000000001 --space-name "Acme" \
  --folder-id 3000000001 --folder-name "Mensajeria" \
  --list-id 4000000001 --list-name "List" \
  --handoff true \
  --status-todo "to do" --status-in-progress "in progress" \
  --status-on-hold "on hold" --status-handoff "update required" \
  --status-done "complete" \
  --available-statuses "to do|on hold|in progress|update required|reviewed|complete"

# ---- db-gateway (backend) — paraguas + subtareas, fin en due_date -----------------
cd /ruta/a/db-gateway
clickup-flow project set \
  --mode umbrella --name "db-gateway" \
  --workspace-id 1000000001 \
  --space-id 2000000001 --space-name "Acme" \
  --folder-id 3000000002 --folder-name "Plataforma" \
  --list-id 4000000002 --list-name "Gateway" \
  --umbrella-task-id 86abc0001 \
  --handoff true --naming prefixed \
  --end-date-field due_date \
  --status-todo "to do" --status-in-progress "in progress" \
  --status-on-hold "on hold" --status-handoff "update required" \
  --status-done "complete" \
  --available-statuses "to do|on hold|in progress|update required|reviewed|complete"

# ---- db-gateway-frontend — mismo tablero, misma paraguas --------------------------
cd /ruta/a/db-gateway-frontend
clickup-flow project set \
  --mode umbrella --name "db-gateway-frontend" \
  --workspace-id 1000000001 \
  --space-id 2000000001 --space-name "Acme" \
  --folder-id 3000000002 --folder-name "Plataforma" \
  --list-id 4000000002 --list-name "Gateway" \
  --umbrella-task-id 86abc0001 \
  --handoff true --naming prefixed \
  --end-date-field due_date \
  --status-todo "to do" --status-in-progress "in progress" \
  --status-on-hold "on hold" --status-handoff "update required" \
  --status-done "complete" \
  --available-statuses "to do|on hold|in progress|update required|reviewed|complete"
```

> `reviewed` queda **sin mapear a propósito**: existe en el tablero pero ninguno de los tres
> proyectos declaró qué significa. El protocolo lo va a reportar como estado sin significado y va
> a mandar preguntar antes de asumir — que es exactamente lo que decían tus skills.

Y la identidad, una sola vez para las tres:

```bash
clickup-flow identity set --id 5000000001 \
  --email atorres@acme.example --name "Ana Torres" --confirmed
```

> Los dos repos de `db-gateway` **comparten lista y tarea paraguas a propósito**: el
> ciclo `update required → in progress (fe) → complete (fe)` ocurre sobre la misma subtarea. Si el
> frontend tuviera tablero propio, `update required` no reservaría nada.

Verificá cada uno con `clickup-flow context`.

### 2. Migrar el mapeo del equipo

El `clickup-usuarios.json` del frontend tenía dos entradas. La segunda estaba marcada
`confirmado: false` con una nota honesta: coincidía el apellido pero **no el nombre de pila**.
Eso se conserva como estaba, sin ascenderlo:

```bash
clickup-flow team add --git-email ana.torres@example.net   --clickup-id 5000000001 \
  --name "Ana Torres" --clickup-email atorres@acme.example --confirmed

# Sin --confirmed: sigue siendo una deducción sin validar, y no se asigna con ella sin preguntar
clickup-flow team add --git-email bsalas.dev@example.org --clickup-id 5000000002 \
  --name "Bruno Salas" --clickup-email bsalas@acme.example \
  --note "Coincide el apellido pero no el nombre de pila. Confirmar antes de asignar."
```

### 3. Quitar la configuración vieja de cada repo

`clickup-flow migrate` ya te dio los comandos exactos con las rutas de tu máquina. En resumen:

```bash
rm -rf .claude/skills/clickup-task-flow .claude/skills/clickup-task-flow-frontend
rm -f  .claude/commands/tarea.md
rm -f  .claude/hooks/recordar-protocolo.sh .claude/hooks/bloquear-sin-tarea.sh
rm -f  .claude/.tarea-actual .claude/.sin-tarea
# clickup-usuarios.json podés dejarlo: ya está migrado y no molesta
```

Y dos cosas **a mano**, que son las que importan:

**El `settings.json` de cada repo.** Borrá solo las entradas de `hooks` que nombran esos dos
scripts. **No toques el resto** — el del backend, por ejemplo, tiene una lista larga de
`permissions.deny` sobre `pytest` que no tiene nada que ver con esto.

**El `CLAUDE.md` de cada repo.** Quitá de la sección de gestión de tareas la referencia a la skill
del repo y —sobre todo— **la declaración de prioridad**. Mientras esa frase esté, el agente va a
buscar el protocolo viejo aunque ya no exista el archivo. `/clickup-setup` te ofrece un bloque
corto de reemplazo, con marcadores para poder actualizarlo después sin reescribir nada.

**Lo que NO se migra ni se borra: `TODO.md`.** Sigue siendo el espejo detallado de las tareas, y
esta herramienta no lo toca ni lo reemplaza. Si tu flujo lo usa, mantenelo como hasta ahora.

### 4. Verificar

```bash
clickup-flow migrate     # ya no debería reportar conflictos
clickup-flow context     # el protocolo que queda tiene que ser el nuevo
clickup-flow doctor
```

---

## Diagnóstico

```bash
clickup-flow doctor      # hooks registrados, identidad, proyectos mal configurados
clickup-flow status      # el proyecto actual, en una pantalla
clickup-flow context     # el protocolo resuelto completo
clickup-flow project list
```

`doctor` detecta específicamente los dos errores silenciosos: un proyecto en modo `umbrella` **sin
tarea paraguas** (crearía subtareas sueltas en la raíz) y una **identidad sin resolver** (no podría
asignar).

### Problemas frecuentes

**"El protocolo no dice nada en un proyecto que configuré."**
Los hooks se leen al arrancar la sesión. Reiniciá Claude Code y corré `clickup-flow doctor`.

**"Me bloquea una escritura y no debería."**
Es el candado haciendo su trabajo. Dos salidas legítimas: reclamar la tarea, o declarar la
exención con su motivo (`clickup-flow exempt --reason "…"`). Si querés apagarlo del todo:
`clickup-flow config set --key defaults.block_writes_without_task --value false`.

**"No encuentra a mi usuario de ClickUp."**
El instalador solo puede consultar la API si le das un token personal, porque el conector que usa
Claude Code es OAuth y no deja token en disco. Sin token, la primera sesión lo resuelve por MCP:
corré `/clickup-config` y elegí `identidad`.

**"Instalé pero Claude sigue usando la skill vieja del repo."**
Las skills del proyecto tienen prioridad sobre las globales. Quitá la del repo (paso 3 de la
migración).

---

## Actualizar

**Instalar y actualizar son el mismo comando.** No hay un `--update`: correr el instalador de nuevo
*es* la actualización.

```bash
cd /ruta/a/claude-clickup-tasks
git pull && ./install.sh          # o  .\install.ps1
```

Qué hace exactamente, verificado con tests que instalan una versión y le ponen otra encima:

| | |
| --- | --- |
| **Motor** | Se reemplaza completo. Un módulo que la versión nueva ya no trae **desaparece** |
| **Skill y comandos** | Se re-renderizan con la ruta del CLI ya sustituida |
| **Archivos obsoletos** | Se borran. Si una versión renombra un comando, el viejo **no queda huérfano** |
| **Hooks** | Se reemplazan sus tres entradas. **No se duplican** por reinstalar |
| **Tu configuración** | Intacta: proyectos, identidad, mapeos del equipo, overrides |
| **Tu `settings.json`** | Intacto salvo nuestras tres entradas. Backup con timestamp antes de escribir |

El instalador te dice qué pasó: `instalado 1.0.0`, `reinstalado 1.0.0 (sin cambio de versión)` o
`actualizado 1.0.0 → 1.1.0`. Y avisa de cada archivo que quitó por obsoleto.

Para saber qué versión tenés:

```bash
clickup-flow doctor      # primera línea: version
./install.sh --status
```

> El manifiesto de archivos instalados vive en `config.json` (`installed_files`). Es lo que permite
> borrar un comando renombrado sin tocar uno que hayas creado vos con el mismo nombre: solo se
> quitan rutas que **esta herramienta puso**.

---

## Desinstalar

```bash
./uninstall.sh                    # o  .\install.ps1 -Uninstall
```

Quita, **usando el manifiesto** (así que también se lleva archivos de versiones anteriores con
otros nombres):

- los tres hooks de `settings.json`, y solo esos;
- los permisos de lectura de ClickUp que agregó, y solo esos;
- la skill, los tres comandos y los wrappers;
- el motor.

**Todo lo demás de `settings.json` queda intacto** — tus hooks, tus `allow`/`deny`, tu modelo, tu
tema. Hay un backup con timestamp antes de escribir.

**No borra la configuración por defecto**, y pregunta aparte si querés hacerlo. Ahí viven tus
proyectos registrados y los mapeos del equipo: si vas a reinstalar, decí no y recuperás todo tal
cual. Está cubierto por tests, incluida la reinstalación posterior.

Si querés borrar todo, incluida la configuración, respondé sí a esa pregunta — o a mano:

```bash
rm -rf ~/.claude/clickup-flow
```

---

## Qué NO va a ClickUp

Credenciales, contenido de `.env`, tokens, claves, volcados de datos de clientes, ni fragmentos de
consultas con datos reales. ClickUp es un sistema externo: lo que se escribe ahí sale del repo.
Vale también para los adjuntos.

Los documentos se **referencian** (ruta + sección + hash del commit), no se adjuntan: un adjunto
queda congelado, y en cuanto el doc cambia, miente.
