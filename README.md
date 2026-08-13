<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# atlas-request-xray

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // atlas-request-xray        │
│  a request pipeline you can break on        │
│  purpose and watch fail in slow motion      │
└─────────────────────────────────────────────┘
```

![Static](https://img.shields.io/badge/static-html%2Fcss%2Fjs-f5a623?style=flat-square&labelColor=0a0a0f)
![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-none-4ade80?style=flat-square&labelColor=0a0a0f)
![Backend](https://img.shields.io/badge/backend-none-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

A simulator for a seven-layer request pipeline: browser, edge, router, api,
service, cache, database. Seven switches decide what happens to a request, and
the diagram plays the result back at a speed proportional to the time each hop
actually took. Turn on a service error with two retries and one browser request
becomes three downstream calls that return nothing after 290ms; the animation
spends that time bouncing between the api and the service, because that is
where the time went.

It exists because retries, timeouts, caching, and rate limiting are easier to
argue about than to picture. A paragraph explaining that a tight deadline turns
a slow request into a failed one is less convincing than watching the same
request succeed at 250ms and fail four times at 50ms.

## Running it

There is no build step and nothing to install. Open `index.html`, or serve the
directory over HTTP if you want module loading to behave exactly as it will in
production:

```bash
python3 -m http.server 8000
```

## What the switches do

Each switch belongs to the layer that owns the behaviour. Browser and database
are passive; they do what they are told.

| Layer | Switch | Effect |
|---|---|---|
| edge | Latency variance | Adds a repeatable amount of extra time to every layer |
| router | Rate limit | Refuses the request with 429 before any downstream work |
| api | Retries | 0 to 3, each waiting longer than the last |
| api | Timeout | 50, 100, 250, or 500ms, applied to each attempt separately |
| service | Service error | The handler raises 503 before it reads anything |
| cache | Cache hit | A miss falls through to the database |
| cache | Stale entry | The cache answers with an expired record, just as fast |

## Scenarios

Five presets set all seven switches at once, through the same object the engine
consumes, so a preset can never express something the switches cannot. Every
preset keeps variance off, so these totals are exact and repeatable.

| Scenario | Total | Downstream calls | Outcome |
|---|---|---|---|
| Healthy baseline | 101ms | 1 | ok |
| Retry storm | 290ms | 3 | exhausted |
| Cache stampede | 470ms | 3 | exhausted |
| Rate limited | 20ms | 0 | rate limited |
| Cascading timeout | 510ms | 4 | exhausted |

The cascading timeout is the one worth sitting with. No single attempt exceeds
its 50ms deadline, and the request still takes 510ms, because the deadline is
per attempt and the backoff between attempts is not counted against it.

## How it is built

Vanilla JavaScript modules, no framework, no bundler, no dependencies at
runtime or at build time.

- `src/engine.js` is pure and DOM-free. Give it a configuration and it returns
  `{ hops, summary }`. It is the only place simulation logic lives.
- `src/playback.js` consumes a hops array and animates it. It knows nothing
  about switches or presets, so any trace can be played, including one pasted
  back in from the copy action.
- `src/explanations.js` holds the fixed library of summary sentences. Templates
  are selected by trace shape and filled with that run's numbers; no prose is
  written at runtime.
- `src/permalink.js` encodes the configuration into the query string. That is
  the only persistence, by design: no backend, no storage, no session.
- `src/app.js` wires the interface together and holds no simulation logic.

The latency constants, the rules the model holds itself to, and the tool's own
failure modes are documented in [`docs/latency-model.md`](docs/latency-model.md).

## Design decisions

**A failure stops where it is owned.** A request that exhausts its retries ends
at the api layer. No response travels back out through the router, the edge, or
the browser, because none did. Only a successful request generates the return
trip. The diagram shows where the pipeline gave up rather than a tidy unwind.

**Hop duration is proportional to real latency.** A fixed interval per hop would
make a 5ms cache hit and a 60ms database read look identical, which is the one
thing this tool exists to show. Playback scales real milliseconds by a constant
and nothing else.

**Latency variance is seeded, not random.** The generator is seeded from the
configuration, so the same switches always produce the same trace. A permalink
has to reproduce an experiment; a link that re-rolls on every load is a
different tool.

**No audio.** Sonification belongs to `specular-sonify`. Request X-Ray stays
visual and silent so the two pieces stay distinct.

**No incident narrative.** There is no diagnosis to reach, no evidence to score,
and no story underneath. This simulates mechanics, not an investigation.

## Accessibility

The diagram is presentational and hidden from assistive technology. The layer
selectors beneath it are real buttons, and the hop table is a complete
non-visual equivalent of the animation rather than a summary of it. When the
visitor has asked for reduced motion, the trace is applied in one pass with no
animation. Every run can also be copied out as JSON.

## Validation

```bash
node --check src/engine.js
node --test test/*.test.mjs
npx --yes html-validate@9.7.1 index.html
```

The test suite locks the retry storm fixture hop by hop, asserts every preset
total, proves the summary equals the sum of its hops across every retry and
deadline combination, and proves no attempt can exceed its own deadline. It
sweeps all 512 reachable configurations twice: once to show none of them falls
through to the fallback explanation, and once to show every outcome the engine
can emit has a status colour to render in. That second sweep is not decorative;
it caught a failure state that would have drawn amber instead of red.

If the model moves, the tests fail before the documentation goes stale.

## How it fits into Atlas Systems

`atlas-request-xray` is a Logic Lego piece: a small self-contained tool that
demonstrates one idea through interaction rather than prose. It carries no
estate data, calls no Atlas endpoint, and depends on no running service, so it
cannot break when something else does and it costs nothing to keep.

The pipeline it draws is the shape of the estate's own request path, but the
numbers are a teaching model rather than a measurement. Where Atlas Systems
publishes real reliability evidence, [`status`](https://github.com/AtlasReaper311/status)
is the surface that does it, and every figure there traces to a request that
actually happened. This one is honest about being a simulation.

---

Part of [atlas-systems.uk](https://atlas-systems.uk) · MIT License
