# OUTBOUND_SPEC — how the engine reaches another server

Standing spec for every request the engine sends to another server. Built
2026-09-29, when the harvesting door (`src/core/harvest/`) joined the two doors
that already existed; the fourth, the paired private agent channel
(`src/core/publication_host/transport.ts`, §2.1), joined 2026-10-03; the harvesting
door gained its second, interactive profile 2026-11-06 (§3.1). Companions: `engineering/EXTERNAL_SPEC.md` §5 (the external
door's own order, which this file does not repeat), `engineering/ERRORS_SPEC.md`
(the code registry), `engineering/TRIPWIRES.md` (the gates named in §6).

The rule in one line: **the engine has FOUR outbound doors, and the request's
KIND chooses the door. The three that reach servers the institution does not
run stand on one guard; the fourth reaches only the institution's OWN paired
publication agent, at the address the operator paired, and stands on that
pairing instead (§2.1).** A new outbound need fits one of the four; a fifth
door, or a private copy of any piece of the guard, is the defect the gates in
§6 exist to refuse. A door may have more than one PROFILE of its policy; a profile
is not a door, because it adds no socket and no guard of its own. The harvesting
door has two (§3, §3.1), and the second is the core's alone.

---

## 1. The guard every door stands on

`src/core/security/ssrf_guard.ts` owns the pieces that must exist exactly once,
because every copy of them so far has drifted from the original:

| Piece | What it guarantees |
|---|---|
| `assertPublicUrl` | RESOLVES the host and vets EVERY address it answers. An address is judged by where it reaches (`isPrivateIp`, through `carriedIpv4`): an IPv6 address inside an AUTHORITATIVE carrier — IPv4-mapped, the NAT64 well-known prefix, or a prefix the operator DECLARED (`DEDALO_NAT64_PREFIXES`) — is judged wholly as its embedded IPv4; one inside a prefix only DISCOVERED from the resolver (RFC 7050) is refused when that IPv4 is non-public but otherwise judged by the ordinary IPv6 rules, so a discovered prefix only ever refuses more. Zone ids are refused. `embeddedIpv4` (the exported fold) follows authoritative carriers only; `claimedIpv4s` answers "which IPv4 MAY this reach" for EVERY carrier — the authoritative fold, the discovered claim, the deprecated IPv4-compatible and SIIT embeddings, and the local-use `64:ff9b:1::/48` read in every RFC 6052 layout — for refusing only (tighten-only). The guard is meant to be the ONE owner of that answer: a caller with its own policy (the on-premise transcriber) reads it instead of keeping a carrier table of its own. The transcriber (`src/core/tools/transcription_local_asr.ts`) judges every IPv4 `claimedIpv4s` returns — the metadata refusal and, exemption OFF, the private-host rule — so the deprecated and local-use readings are withheld wherever an authoritative carrier (well-known or DECLARED) already reads the address: the declaration IS the layout, and a spurious reading (the zero suffix of a declared `/48` read as `0.0.0.0` at `/96`) would refuse what the guard accepts. PENDING: it still unions a redundant copy of the deprecated and local-use tables into its metadata check; that copy is to be deleted, and no module outside `src/core/security/` may import a carrier primitive (`extractRfc6052Ipv4`, `packedInBlock`, `packBlocks`, `packCidr`) without a reasoned census row (`ssrf_one_guard_tripwire`). |
| `isAddressRefusal` | Tells a caller "the guard refused the ADDRESS" without the caller copying reason strings. A module other than the guard that spells an address reason is refused (`ssrf_one_guard_tripwire`). |
| `pinToVettedAddress` | Points the socket at the VETTED address, keeping the real host for `Host`, SNI and certificate identity — so a resolver cannot answer "public" to the check and "internal" to the connect (DNS rebinding). Self-checks the result. |
| `readBytesCapped` | The one streamed, capped body reader: over the ceiling the body is CANCELLED (never drained), either refused or truncated-and-flagged; an idle bound drops a peer that goes silent. |
| `untilAborted` | The one "race a promise against a stop" primitive: the awaited work is never cancelled, the listener never outlives the call. Gated by OUTCOME: every harvest wait on a job's signal must leave no abort listener behind (`harvest_door_native`). |
| `parseRetryAfterMs` | The one `Retry-After` reader (digits or an HTTP-date, anything else null), UNCLAMPED — each door applies its own ceiling. Gated by OUTCOME at each door that honours the header: a lenient date `Date.parse` would read (`2099-01-01T00:00:00Z`) must ask no wait (`harvest_door_native`, `external_transport_native`). |
| `fetchPinnedHop` | The shared pinned primitive: ONE request, vetted and pinned, redirect handed back unread (§4). |
| `fetchGuardedText` | `fetchPinnedHop` used ONCE: vetted AND pinned (the name is resolved once, the socket connects to the address that was vetted), bounded, and any 3xx with a `Location` REFUSED as a typed `security.outbound_failed` reason `redirect`. |

Address refusals are `security.ssrf_blocked` at the single-call and harvesting
doors, with OPERATOR disclosure: naming what a host resolved to is the
internal-network oracle the guard exists to deny. The external door classifies
the same refusal in its own taxonomy, as `external.blocked_host`
(`engineering/EXTERNAL_SPEC.md` §5), which discloses no address either. Transport failures at the primitive are
`security.outbound_failed` (reason `timeout` / `idle` / `aborted` / `transport` /
`body_cap`, with the `stage` — resolve / connect / body — where it applies); at the
single-call doors a refused redirect is reason `redirect` and a non-2xx answer
carries its `status` (message `HTTP <n>`), its body cancelled unread — an error
page never costs the ceiling or the deadline, and never turns into a timeout or a
`body_cap`.

## 2. The four doors

| Door | For | Redirects | May be used by |
|---|---|---|---|
| `fetchGuardedText` (`ssrf_guard.ts`) | ONE call to an API: a translation service, a speech-to-text provider — vetted and PINNED | REFUSED — a 3xx re-chooses the target | engine code only — never a tool (§6) |
| `fetchExternalJson` (`src/external/transport.ts`) | an external RECORD SERVICE bound in the ontology | REFUSED | `src/external/` only |
| `harvestFetch` (`src/core/harvest/harvest.ts`) | a page, image or file on ANOTHER SITE, the way a person would reach it | FOLLOWED, one vetted hop at a time (§3) | tools that harvest — the default profile; the interactive profile (`interactiveFetch`, §3.1) is a core route's alone |
| `agentRequest` (`src/core/publication_host/transport.ts`) | the institution's OWN paired publication agent (`engineering/PUBLICATION_HOST_SPEC.md` §2), over mTLS or a unix socket | REFUSED — the agent never redirects | the publication-host client only (§2.1, §6) |

Choosing: a service whose endpoint the operator configured → `fetchGuardedText`.
A record resolved from a third-party catalogue → `src/external/`. Anything a
cataloguer pasted or a crawler found on someone else's website → `harvestFetch`.
A request a PERSON is waiting for that a core route relays from a source the
institution stored (a map tile) → the same door's interactive profile, in the core
route only (§3.1). The institution's own publication host → `agentRequest`, through the
publication-host client, never directly.
No tool holds a raw door. The shrink-only list of reasoned tool rows reached
zero on 2026-10-01, when `tool_import_rdf` (whose single-call fetch refused the
303/301 every linked-data server answers with) moved to `harvestFetch`; a list
at zero stays at zero (`test/unit/ssrf_one_guard_tripwire.test.ts`).

**The publication-host public-URL probe is a `fetchGuardedText` caller, not a door**
(`src/core/publication_host/probe.ts`, `engineering/PUBLICATION_HOST_SPEC.md` §7). It
requests two media files from the institution's own public site exactly as a stranger
would, so it relies on the public guard unchanged. A public URL that resolves to a private
address (split-horizon DNS included) is refused like any other, and the probe reports
`unknown`, never a pass. The 404 it expects for the unpublished file arrives as the typed
`security.outbound_failed` carrying `status: 404`, with the error page cancelled unread;
the probe reads the status, never a body. The same subsystem's agent channel is a door of
its own (`agentRequest`, above). The probe never uses it: a gate seen from the private side
proves nothing about what the public sees.

**The geo services are a `fetchGuardedText` caller, not a door**
(`src/core/geo_services/`, the one entry point `callGeoService`). On behalf of a tool or a
job they ask five public providers — Nominatim, DARE (imperium.ahlfeldt.se), Catastro, the
IGN's WMS and open-elevation — a CLOSED set of fixed questions (a place name, a point, a
parcel, an elevation), and add what a single-call door cannot know. The request names no
address: its id is a key of a closed table (origin and path, the fixed parameters, the
grammar of every parameter a caller may add, the answer's byte ceiling and deadline, the
shape of a good answer), its parameters are checked against that grammar — an unknown key,
a missing one or a value off its grammar is `request.invalid_data` before any socket or
slot — and the URL is built from the table with `URL` and `URLSearchParams`, so no value
can move the host, the path or the query's structure. No configuration key moves an
endpoint, a ceiling or a pacing: the providers' terms are the code's, and a change is a
reviewed edit of the table — and the table is frozen to its LEAVES at load (`frozen.ts`), not
shallowly: a tool that imports it cannot rewrite a row (`GEO_ORIGINS.nominatim.base`), which the
address check would otherwise have accepted since it compares the URL with the row it was
handed. It holds no RegExp either (a RegExp is not made immutable by freezing: `compile()`
rewrites it before it fails), so a pattern lives in a closure. Free text is bounded by its RAW
length before it is normalized (`NFC_SHRINK_LIMIT`: NFC cannot shrink a string by more than
4x), because `normalize()` is quadratic on a long run of combining marks and one request body
may be hundreds of MiB. Every call dials through the guard unchanged (resolved and
vetted, pinned, no redirect, bounded deadline and body) and through a PER-PROVIDER limiter —
the interactive profile's primitive (`origin_limiter.ts`, §3.1), each instance with state of
its own: calls in flight, the spacing between starts, a bounded queue and wait, and a back-off
after a 429 or a 503 during which a newcomer fails fast with `rate.limited` (every origin's
back-off is longer than its wait ceiling, gated). For an origin that lets ONE call fly at a
time (Nominatim, DARE, open-elevation) the spacing is also counted from the END of the previous
call, so the rate holds ON THE WIRE and not only between the limiter's starts — and a slot is
ONE request at the provider: the call asks the text door to move on to another vetted address only
when nothing was sent (`resendOnlyUnsent`, the rule a POST always gets), because the door's default
sends a GET to the next address after any connect-level failure, which put a second request on the
wire, 0 ms after the first, whenever a reset arrived after the first one left. A start is
reserved before the guard resolves the name and handshakes, how long that takes differs from
call to call, and two starts a second apart can reach the provider half a second apart. Since
a call's wire moment lies before its slot comes back, a rest of one interval after the slot
returns leaves at least that interval at the provider whatever the resolver and the handshake
did (Nominatim: at most one request a second from the whole installation); an origin that lets
several calls fly at once states no such rate and keeps the start-to-start spacing alone. The
numbers of an origin add up: the Nth caller in line starts about N x (call time + interval)
after it arrived, so `maxQueue` is reached only while that stays inside `maxWaitMs` (Nominatim:
four queued behind a call while calls last under 400 ms) and slower calls make the wait ceiling
refuse the last in line first (`rate.limited`, `wait_exceeded`) — both bounds are real, the gate
drives the ceiling at the millisecond with calls that take time, and requires that a queue could
fill with instantaneous calls. A limiter key owing spacing or a back-off holds ONE drain timer
however many newcomers the back-off refuses: a timer per refusal would have made the live timers
follow the request rate times the back-off (30 s).
IDENTICAL CALLS IN THE AIR ARE ONE CALL (`flights.ts`): a tool action runs in a plain HTTP
request, the browser transport re-sends when its 5 s attempt deadline fires, and the aborted
attempt is never told, so without sharing every re-send would take a queue place and a provider
request of its own. A call is keyed by the service and the address the engine built (public
data, no user or session in the key); a call that arrives while an identical one flies joins it,
each caller reads the body for itself, a failure is shared like an answer, and the flights keep
nothing after the answer. WHERE THE PROVIDER ASKS FOR ITS RESULTS TO BE CACHED, A SMALL MEMORY
KEEPS THEM (`answer_memory.ts`, the table's `keepAnswerMs`): Nominatim's usage policy says results
must be cached on our side and that a client sending the same query again and again may be
blocked, and the flights cover only questions asked at the same moment — a cataloguer's repeat
search, or the browser transport's re-send after the first attempt has finished, would otherwise
reach Nominatim every time. An identical question inside the hour (both Nominatim services) is
answered from memory, with no flight, no slot and no request. It keeps the body text of a good
answer or of the provider's "nothing there", never a failure or an answer off the contract, and an
entry over 64 KiB is served but not kept; it is keyed by the service and the address the engine
built (public data, no user or session in the key), bounded BY BYTES (2 MiB, counting each entry's
body, key and a fixed overhead; the oldest go first) and time-cleared. The text door hands back no
headers, so a provider's own `Cache-Control` is replaced by the table's lifetime. Permission is the
caller's and runs before `callGeoService` is entered, so a hit can only answer a caller who was
allowed to ask. A caller that is stopped (a job's signal) leaves ITS
wait and the call goes on for the callers that remain; it is cancelled, socket released and slot
handed on, only when the last one has gone. The stoppability contract is the job's signal where
one is in scope and the bounds elsewhere: unlike `interactiveFetch`, whose route is core and
wraps the request's signal, a tool action in a plain request has no signal (the process has no
`request.signal` plumbing, `api/dispatch.ts` gate 4; `ToolActionContext.signal` exists only
under the background executor), so the call is NOT refused without one — it runs to its bounds
(the limiter's wait ceiling plus the service's deadline) and its re-send shares it. When the
dispatcher hands a foreground action its request's signal, an action that wraps its calls in
`runWithJobSignal` makes them stoppable with no change to the module. The User-Agent
identifies the installation (release identity, the project site, and its public origin only when
a provider could reach it: never a loopback, private or reserved address, a single-label name
or a `.local`/`.internal`/`.lan`/`.home.arpa`/`.test`-style name, since that header goes to five
third parties on every call; a value that is not safe to send is left out whole, never repaired).
No person's address is sent: the mailer's From address configures the mailer and is not a
statement of who to write to, and a contact would be a key of its own, opt-in. There is no key of
the module's own. Failures are one taxonomy that names the service
and the provider's id and never an address, a host or a query (operator disclosure), and the code
decides whether the browser transport re-sends (it re-sends a retryable failure up to five times):
`external.not_found` (a 404 or 410, or the provider saying there is nothing for a service
that asks a question with one answer; a search that finds nothing is an empty result),
`external.http_status` (a TRANSIENT status — a 5xx, 408, 425 — retryable, `retryAfterMs` on a 429
or 503), `external.bad_config` (the provider REFUSED this request: any other 4xx, a 400, 401 or 403
— NOT retryable, because the same bytes get the same answer and a block is where repeated sends
hurt; the status is in the log), `external.timeout`, `external.transport` (a refused redirect and a
name that did not resolve included — `dns_failed` and `no_addresses` are a lookup blip, retryable,
not a policy verdict), `external.too_large`, `external.protocol` (an answer off the service's
contract) and `external.blocked_host` (the guard judged the resolved address non-public).
Catastro's licence forbids distributing its original information untransformed, so its
services are LOOKUPS for a caller that extracts what it needs, with a capped box — never a
relay of its imagery (map tiles are the interactive profile's, §3.1). Two limits are stated,
not hidden: the text door returns the body without its headers, so a provider's own
`Retry-After` is replaced by the table's back-off, and it decodes UTF-8 whatever charset the
provider declares (measured 2026-11-06: Catastro declares ISO-8859-1 but sends UTF-8 bytes). The census
(`ssrf_one_guard_tripwire`) deliberately does not follow a wrapper, so a tool that imports
`callGeoService` holds no raw door by binding and can ask the table's questions and no
other; the census pins the wrapper's own shape instead — one module dials, through
`fetchGuardedText` alone, the entry point is the only export, and it takes exactly
`(id, params)`. The text door's test seams (the resolver and the socket, which ARE the guard's
pin and address vetting) are not a parameter: they ride a scope (`geo_seams.ts`) whose opener
no module of `src/` or `tools/` may bind by any route, read as a door of the same
import-graph census. The module imports nothing of `src/config/`, reads no environment and
imports a closed list of modules per file. Behaviour: `test/unit/geo_services_native.test.ts`
(§6).

`fetchBoundedText` is the SAME transport core as `fetchGuardedText` (the hop's
total deadline composed with the job's signal, the shared capped reader, the same
typed failures, any 3xx refused) with NO pin and NO address policy. It exists for
a destination that is legitimately PRIVATE (an on-premise sidecar on the
institution's LAN), so such a caller never copies a bare `fetch` to get the
timeout and the ceiling. Every caller must apply its OWN named address policy
first, and is censused for it.

**Named residual — the local-ASR door (`isSafeLocalAsrUrl`,
`src/core/tools/transcription_local_asr.ts`).** Its policy is synchronous and
judges only the configured host's LITERAL forms: a transcriber URI whose NAME
resolves to a metadata address (169.254.169.254, `fd00:ec2::254`) or a tunnel
passes the "metadata never, exemption or not" rule, and `fetchBoundedText` then
connects by name, unpinned. The URI is admin tool-config, not client input, so
this is not a client-supplied SSRF — but it is a door that judges without
resolving. Closure: resolve the host through the guard's lookup, refuse when any
answer (or any `claimedIpv4s` form of it) is metadata or a tunnel, and connect
pinned to the vetted address through a private-policy variant of the pinned hop
(the `fetchPinnedHop` core with the policy injected).

**The ontology manifest client is a `fetchBoundedText` caller, not a door**
(`fetchOntologyManifest`, `src/core/ontology/ontology_manifest.ts`). The installer
(the terminal installer) reads an ontology master's catalog SERVER-side — which TLDs it
offers and their declared dependencies — before anything is imported. An ontology
master may legitimately sit on the institution's LAN, so the public-address policy
cannot apply. Its named policy is `assertConfiguredMasterUrl`: the URL dialled must
be EXACTLY, after URL normalization, one of the configured master API URLs (the
`ONTOLOGY_SERVERS` entries, or the install plan's official constant). That is
operator configuration, never request text, and a URL that is not one is refused
`internal.invariant` before any socket opens. The call carries an explicit 30 s
deadline and an 8 MiB ceiling, and refuses any 3xx. Its failures are reported as
the HTTP status or the transport `reason`, never the address. The ontology FILES it
lists are downloaded by the existing origin-pinned `downloadRemoteOntologyFile`
(`data_io_import.ts`, a burn-down `EXEMPT` row), never by a new fetch site. Census:
`outbound_fetch_tripwire` (`ADDRESS_POLICY`, plus a leg that the one transport call
dials the URL the policy judged). Behaviour: `ontology_manifest_native`.

The external door's nine-step order (kill switches, breaker, host allowlist
before any DNS, vet + pin, credential attached last, capped read, retry,
breaker update) is `engineering/EXTERNAL_SPEC.md` §5, and its failures are the
external taxonomy there — not repeated here.

### 2.1 The paired private agent channel

The publication agent (`engineering/PUBLICATION_HOST_SPEC.md` §2) listens on an
address that is private BY DESIGN: a WireGuard peer, a firewalled LAN port, or a
unix socket on this machine. `assertPublicUrl` refuses exactly that, so the
agent cannot be reached through `fetchGuardedText`; and an `EXEMPT` row would
say "not yet on the guard" about a destination that must never be on it. It is
therefore a named door, `src/core/publication_host/transport.ts`, with its own
policy, in this order:

1. **The route table is closed.** The path is one of the agent's literal routes
   (`AGENT_PATHS`, below `AGENT_BASE_PATH`, which only the door prefixes), the
   method GET or POST — PUT on exactly the routes `AGENT_PUT_PATHS` names (today
   copy mode's `/v1/media/file`), which take nothing else — the bounds inside
   their ceilings (1 MiB default / 16 MiB response, 10 s default / 30 min
   deadline — a PUT route's ceiling is `MAX_PUT_TIMEOUT_MS`, the agent's largest
   media file at the slowest sized link; a put's own deadline is
   `mediaPutDeadlineMs(size)`), the bearer one token of the secrets store's own grammar, and the
   caller sets none of the transport's headers. A query is never part of the
   path: a route that takes one declares its keys in `AGENT_QUERY_GRAMMAR`
   (`/v1/media/manifest`: `cursor`, the agent's own base64url, and `limit`, a
   plain decimal; `/v1/media/file`: `path`, REQUIRED, a relative media path with
   no control character, backslash, or empty / `.` / `..` segment, at most 1024
   UTF-8 bytes — the agent's bound), every value
   must match its closed grammar, and the door encodes it, so no value changes
   the URL's structure. A breach is a programming error (`internal.unexpected`),
   refused before any socket opens.
2. **The target is the registry entry, exactly** (`agentTarget`). TCP:
   `https://<host>:<port>` with mTLS from the host's engine bundle — the client
   certificate and key, the bundle's CA as the ONLY trust root,
   `rejectUnauthorized: true`, the certificate checked against the REGISTRY host.
   The explicit `true` is load-bearing: measured on Bun 1.4.2, it is what keeps
   verification on when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the environment.
   A unix-socket host is dialled at its socket, and only after the filesystem
   vouches for it (`assertSocketSafe`): the path exists (else reason `transport`),
   `lstat` says it IS a socket (a symlink or any other node is refused), its
   directory is writable by nobody but its owner (any group/other write bit is
   refused — no sticky exemption: a sticky world-writable directory such as `/tmp`
   lets anyone CREATE the name), the socket is owned by that directory's owner,
   root or the engine user, and every directory above it — on the path as written
   and on its realpath — is owned by one of those uids and writable by no one else
   (a sticky ancestor passes only when the entry below it is owned by root or the
   engine user — never the directory's owner: anyone may create a name in a sticky
   world-writable directory, so a squatted `/tmp/x` owned by its squatter is refused)
   — else reason `socket_perms`. The guarantee: only the owner of the directory
   the operator registered (or root, or the engine user) could have placed the
   socket. The registry holds no agent uid, so which uid that is stays the
   operator's choice; the provisioned shape (the agent's 0750 RuntimeDirectory
   under root-owned `/run`) passes. No caller text reaches the URL.
   A TCP host without its engine bundle, or with one the secrets store refuses,
   is `publication_host.unconfigured`.
3. **One request.** `redirect: 'manual'`; any 3xx is refused, its body cancelled
   unread — a 3xx means something other than the agent answered.
4. **Bounded.** One total deadline from connect to the last body byte, an idle
   bound on the body (default min(deadline, 30 s), a caller may only lower it; an
   idle body is `publication_host.timeout` even when the deadline is far off), the
   guard's `readBytesCapped` (cancelled over the ceiling). A request body may be a stream (release bundles).

The bearer is attached only when the caller passes one, and the one production
caller passes it only after proving the pairing on the agent's unauthenticated
`/health` (`PUBLICATION_HOST_SPEC.md` §2 rule 3) — which is why `agentRequest`
has exactly one production holder (§6). A non-2xx answer is returned for that
client to map; transport failures are `publication_host.unreachable` (reason
`transport`, `tls`, `redirect` or `socket_perms`), `publication_host.timeout` and
`publication_host.failed` (reason `body_cap`), all minted by
`src/core/publication_host/wire.ts`, with log-only coordinates that never carry
the bearer or key material.

**Named residual — the proxy environment.** Bun's fetch routes a TCP (https)
agent target through `HTTPS_PROXY` when it is set, and no per-request option
turns that off (measured on Bun 1.4.2: `proxy: false`, `null` and `''` are all
still proxied). `HTTP_PROXY` alone does not apply to the https target, and a
unix-socket agent is never proxied. mTLS still ends at the agent, so a proxy sees the channel's
address and ciphertext, never the bearer, but the channel is then not private
and the agent's firewall sees the proxy's address. The operator lists every
agent address in `NO_PROXY`. Three canaries in `publication_host_transport_native`
turn red when Bun stops proxying this call through `HTTPS_PROXY`, starts
proxying it through `HTTP_PROXY` alone, or starts proxying a unix-socket agent,
so the residual is re-read then.

## 3. The harvesting door, hop by hop

A harvester needs what an API call must refuse (following redirects) and owes
what an API call does not (robots.txt, a polite pace). `harvestFetch` — the
DEFAULT profile, and the only one a tool can reach — runs the whole contract for
EVERY hop of a redirect chain, in this order (the interactive profile swaps steps 3
and 4 and tightens the rest: §3.1):

1. **URL shape** — http(s) only, no credentials in the URL, never https → http,
   https only when the caller asked for it, no longer than `MAX_URL_LENGTH`.
2. **The caller's host policy** — `'public'`, or an allowlist of sites (a site
   admits its subdomains, never a look-alike).
3. **robots.txt** for the hop's origin, as RFC 9309 defines it: 4xx allows
   everything, and so do more than `MAX_REDIRECTS` redirects (§2.3.1.2); 5xx /
   429 / no answer — and a 3xx the fetch does not follow (no `Location`, or a
   300 / 304 / 305) — is a COMPLETE disallow, retryable
   (`harvest.robots_unavailable`); a redirect the per-hop URL rules refuse is a
   complete disallow too, but deterministic, so NOT retryable
   (`robots_redirect_refused`, kept for the normal TTL). The file is read to
   `ROBOTS_MAX_BYTES` (512 KiB) and a longer one is TRUNCATED at its last whole
   line, not refused; a file that is not UTF-8 is read byte-wise (`%XX` for every
   byte from 0x80); a file with more than `ROBOTS_MAX_RULES` (4096) rules for us or
   a pattern longer than `ROBOTS_MAX_PATTERN_LENGTH` (2048) is refused whole
   (`robots_too_complex`) — a DELIBERATE deviation from §2.5, whose parsing floor
   is 500 KiB: a short file of 4097 rules is refused although it is well under it.
   The rule text has no bound of its own (the byte ceiling bounds it, the encoding
   at most triples it), so any file within the byte ceiling and the two caps is
   obeyed as written, in any script. The cache of verdicts is bounded by origin
   count and by what it retains (`ROBOTS_CACHE_MAX_WEIGHT`, rule objects counted
   as well as pattern text). Rule and path meet in ONE
   percent-encoding (§2.2.2: unreserved `%XX` decoded, non-ASCII and unsafe ASCII
   encoded); the path is judged in every distinct form — as sent and canonical
   (`/` runs collapsed, `;params` stripped), each also with literal `*` / `$` as
   `%2A` / `%24` (§2.2.3), each also with reserved `%XX` decoded on both sides —
   and any form disallowed refuses. Each match is linear in path + pattern (KMP,
   never the host's `indexOf`), and the WORK of a hop — wildcard rules × the
   length of every form, plus the pattern text per form — is weighed before any
   match: past `ROBOTS_MAX_MATCH_WORK` the hop is refused as `robots_too_complex`
   (the input bounds alone do not compose: measured 610 ms for one hop inside all
   of them). The robots fetch is itself a pinned, vetted, bounded request under
   one fixed policy.
4. **The per-origin pace** — one request at a time per origin (keyed by
   `siteKey`: the origin with a trailing root dot dropped, so `example.org.` is
   not a second server), our own floor between them, the site's `Crawl-delay` and
   `Retry-After` honoured but clamped. The robots cache keys the same way.
5. **`fetchPinnedHop`** — every address public, the socket pinned, a total
   deadline (from the DNS resolution of the address check through the last body
   byte) and an idle one, the job's stop signal (which also ends a resolver that
   never answers), the capped read; with an expected media type, a 2xx of
   another type is refused before its body is read.

A 3xx carrying `Location` becomes the next hop and starts again at 1, up to
`MAX_REDIRECTS`; one more is a refusal, never a silent stop on a 3xx. Any other
answer, 4xx and 5xx included, is RETURNED with its status: a missing lot is
information the tool reports, not a transport failure.

The door does not parse, judge what a page means, or detect a bot-challenge
page served with 200. Those are the tool's.

| Code | When |
|---|---|
| `harvest.refused` (public) | a policy said no; `details.reason` is one of `unparseable`, `protocol`, `credentials`, `url_too_long`, `requires_https`, `downgrade`, `host_not_allowed`, `port_not_allowed` (the interactive profile only, §3.1), `bad_location`, `too_many_redirects`, `robots_too_complex`, `robots_redirect_refused`. `details.site` is the origin the caller asked for — for the two `robots_*` reasons the origin whose robots.txt decided, for `unparseable` a fixed token (never the caller's text) |
| `harvest.robots_disallowed` | the site's robots.txt disallows the path |
| `harvest.robots_unavailable` (retryable) | the site failed to deliver its robots.txt |
| `harvest.too_large` | the body passed the caller's ceiling (the primitive's `body_cap`, mapped at the door) |
| `harvest.unexpected_type` | a 2xx of a media type the caller did not expect |
| `security.ssrf_blocked` | the address refusal of §1 — never softened into a `harvest.*` code |
| `security.outbound_failed` | timeout, idle, stopped job, transport |

### 3.1 The interactive profile — `interactiveFetch`, a core route's alone

Everything above is a crawler's contract: it asks robots.txt (RFC 9309 governs
automated crawlers) and keeps a strictly serial pace at least 3 s apart. A map viewer
is not a crawler. A person's browser asks for a tile; a core route relays it for that
person, from a source the institution stored. robots.txt does not scope that request,
and a 3 s serial pace turns a map into a slideshow (a view asks for a dozen tiles at
once). The interactive profile exists for exactly that case, and for no other. It does
not loosen the default profile — every acquisition tool was written against that
contract, and `harvestFetch` behaves exactly as it did — it is a second profile of
the same pipeline (`harvestWith`, module-private) with its own policy and its own
state.

| | Default (`harvestFetch`) | Interactive (`interactiveFetch`) |
|---|---|---|
| Who may call it | tools that harvest | ONE core route (`INTERACTIVE_IMPORTERS`: a checked row, not a free-text excuse) |
| robots.txt | every hop | never asked |
| Pace | one request at a time per origin, 3 s apart; `Crawl-delay` and `Retry-After` clamped to 60 s | at most 4 in flight per origin and 16 across all origins — of which an address an EDITOR wrote (`addressFrom: 'stored'`) may hold at most 8, with a queue of at most 32 for that share, and ONE holder (`holder`: the person waiting) at most 3 of the 8, with a queue of at most 512 of their own — while an address an ADMINISTRATOR chose (`'registry'`) takes, per holder and per origin, at most 4 places in that origin's queue, the rest of a person's view waiting in a line of their own (also 512) (see *Who chose the host* and *Who is waiting* below); an optional `minIntervalMs` — the spacing a start OWES the starts after it at that origin (at most 5 s; see *Spacing* below); a queue of at most 256 per origin (a 3840x2160 layer is 16 x 10 = 160 tiles asked at once) and 512 overall; each caller waits at most 10 s IN ALL for its start — the origin's queue, the shared queues and the spacing together, one ceiling counted from when it first queued, per hop — then `rate.limited`; a 429/503 holds the origin for its `Retry-After` (at most 30 s; 2 s when it names none) — a start already reserved and pausing when it lands included — and while that outlasts the 10 s every newcomer is refused at once instead of queued |
| Its state | `pacing.ts` | five `OriginLimiter` instances (`origin_limiter.ts`, built in `interactive_limits.ts`: per origin, across all origins, across stored addresses, per holder, per holder at one origin), closed over their own maps and self-draining; shared with the default pace in no key, count or clock; module state, so each site is listed with its lifecycle in `module_state_tripwire` |
| Request | GET or POST, optional body | GET only, no body |
| Who chose the host, who is waiting | not asked | REQUIRED `addressFrom`, a closed two-value field of `InteractiveRequest`, and REQUIRED `holder`, an opaque name of at most 64 characters (*Who chose the host* below); anything else is `internal.invariant` before any wait |
| Headers a caller may set | `Accept`, `Accept-Language`, `Content-Type`, `Referer`, `X-Requested-With` | `Accept`, `Referer`, and the two validators of a revalidation, `If-None-Match` and `If-Modified-Since` (a field of the profile: the default profile's caller still may not send them). The `User-Agent` is the door's in both profiles, never the caller's; the interactive one names the installation as contact, `dedalo/<release> (+<public origin>)`, or falls back to the shared identity (*Identity* below) |
| Hosts | `'public'` or an allowlist | an allowlist, at least one entry — a stored address that redirects elsewhere is `host_not_allowed` |
| Ports | any | the scheme's own (80 for http, 443 for https) on EVERY hop, the first and each redirect target: another port of an allowed host — the installation's own public address included — is `harvest.refused` reason `port_not_allowed`, before any socket. An allowlist names a host, not what runs on it |
| Media type | optional prefixes | required, matched EXACTLY (`image/png` does not admit `image/pngx` or `image/svg+xml`) |
| Body | 20 MiB default, 100 MiB ceiling | 1 MiB default, 8 MiB ceiling |
| Time per hop | 120 s default, 10 min ceiling, 30 s idle | 10 s default, 20 s ceiling, 5 s idle |
| Response headers a caller may read | `cf-mitigated`, `content-disposition`, `content-length`, `content-type`, `etag`, `last-modified`, `retry-after` | those, plus `age`, `cache-control`, `date`, `expires` — what a route that caches what it relays needs to follow the provider's own lifetime; a field of the profile, so a tool's view of a response is unchanged. Never a cookie |
| Without a job signal | runs | refuses (`internal.invariant`, before any wait): see the route's duties below |

What does NOT change: steps 1, 2 and 5 of §3 are the same code for every hop (URL
shape, never https → http, the host policy — with the port rule above added —,
`MAX_REDIRECTS`, `fetchPinnedHop`: every address public, the socket pinned, the job's
stop signal, the capped read), each redirect hop re-vetted and taking its own origin
slot in turn; the identity is the same
`HARVEST_USER_AGENT` (the interactive profile adds the installation's origin, *Identity* below); the failures are the same codes plus `rate.limited` (operator
disclosure) from the limiter. A non-2xx answer is returned with its status, as above.

**A tool cannot select it** — by type, at run time, and by census:

1. No type carries a profile. `HarvestRequest` and `HarvestDeps` have no such field, and
   `InteractiveRequest` is narrower than `HarvestRequest` (no method, no body, no wait
   observer, no `'public'`). The profile table and the pipeline both profiles run
   (`harvestWith`) are module-private, and that is gated by OUTCOME, not by a name: the
   runtime export surface of `harvest.ts` equals an exact list, and `followVetted` is
   referenced exactly once there (a direct call) and once in `robots.ts`
   (`ssrf_one_guard_tripwire`) — an exported pipeline, or a second call site with a
   `beforeHop` of its own, is how a profile could become a value a tool chooses.
2. `harvestFetch` REFUSES a request or deps that nonetheless carry a `profile` or
   `interactive` key (`internal.invariant`, before any socket): a tool is JavaScript at
   run time, and a payload spread into the request must not silently pick — or silently
   fail to pick — a profile.
3. `interactiveFetch` is censused as a door (`ssrf_one_guard_tripwire`): a file under
   `tools/` that holds it, by binding, fails, a row cannot excuse it; a core module holds
   it only by an `INTERACTIVE_IMPORTERS` row, exact both ways. The row is
   `{ reason, gate, handlers }` and is CHECKED: at most ONE row; the route module's runtime
   exports (Babel AST) are exactly `handlers`; `gate` is a native gate of its own
   (`test/unit/<route>_native.test.ts`, never one of the door's) that exists, imports the
   route, names every handler and carries at least ten tests. The table has ONE row, the
   map tile proxy (§3.2); the checker is also driven on synthetic rows. The disclosure
   census (a tool that holds an outbound door reads no error's `.message`) names it too.

**Spacing.** `minIntervalMs` is what a start OWES the starts after it at its origin: no
later start sooner than that after it, whatever the later one asks for itself. It is not a
promise about the gap BEFORE a start — after a start that asked nothing, one that asks 1000
may go at once — so a provider's terms are a property of the ORIGIN and the route passes
them on EVERY request to that origin, a stored source on a host a closed built-in also names
included. The start is reserved last: the request takes its origin slot, then (for a stored address)
a stored one, then a global one, and only then reserves its place in the origin's sequence and
waits it out, holding all of them. A
spacing reserved before the global queue would be released by it together with its
neighbours, and the provider would see them at one instant, which is exactly when a viewer
fires many requests. A reservation whose caller leaves before its start (a stopped job, a
ceiling) is given back, so a viewer who pans away burns nothing. A provider's back-off binds the
starts already reserved too: when a 429/503 `Retry-After` lands while a start is pausing, that
start checks what is owed when its pause ends, waits again if the back-off moved it (the starts
behind it keep their order and their spacing) and is refused (`rate.limited`, `wait_exceeded`) if
that carries it past its ceiling — it never goes inside the `Retry-After` the provider has just
asked for.

**Identity.** The default profile's `User-Agent` is one string for every installation of a
release (`dedalo/<release> (+https://dedalo.dev; heritage cataloguing)`): right for a crawler,
whose webmaster wants to read what Dédalo is, and UNCHANGED by the installation's address. The
interactive profile relays the requests of an installation's viewers to providers with usage policies
(every built-in and every stored source), and OpenStreetMap's asks a proxy for a clear, contactable
identity of the organisation or service and forbids a generic proxy identity that tunnels all clients
behind one name. So the interactive profile names the INSTALLATION as the party to contact, in the
`+URL` convention: `dedalo/<release> (+https://museum.example.org)` (`harvest/installation_identity.ts`).
The origin is byte for byte the one the route's `Referer` and the geo services' `User-Agent` send
(`resolve/public_reach.ts` `reachablePublicOrigin`: ONE derivation, per call, from `DEDALO_PROTOCOL` +
`DEDALO_HOST`, never from a request header). The configured value is parsed ONCE as a WHATWG URL and that
parsed value is judged: no control character or whitespace as configured; scheme `http:`/`https:` (any
spelling URL parsing reads as one: `HTTPS://`, `https:host`); a BARE origin (no credentials, no path but
`/`, no query, no fragment, not even an empty `?`/`#`); a host reachable from outside (not loopback, not
a private or reserved literal, well-formed labels of 1–63 letters/digits/hyphens with no hyphen at either
end and no empty label but one trailing dot, at least two labels, under no special-use or private suffix
— `.local`, `.internal`, `.lan`, `.arpa`, `.alt`, `.test`…); a canonical origin of at most 100
characters. What URL parsing canonicalizes is the same origin and accepted (host case, an IDN host sent
as punycode, a default or zero-padded port, a trailing `/`); the output is always ASCII. A value that
carries credentials, a path, a query or a fragment is NOT repaired: it yields no origin for ANY sender —
no contact `User-Agent`, no `Referer`, no origin in the geo services' header. No configuration key is
added for it. An installation with no such origin (unset, loopback, private, an intranet name, a
malformed or unclean value) sends the SHARED identity, the default profile's string — the less
identifying fallback, which every such installation shares — and no `Referer`. A provider whose terms
forbid relaying under such a generic identity (OpenStreetMap: `requiresInstallationIdentity` in the
registry, matched on every host under the provider's listed domains — `openstreetmap.org`, `osm.org`, `openstreetmap.com`) is NOT relayed from such an installation: the
tile route refuses it (`external.disabled`, after the gates, before the memory) and the viewer's browser
loads it directly (§3.2). Every other provider is relayed under the shared identity. A caller sets
`User-Agent` on neither profile.

**Who chose the host.** A request names `addressFrom`, and the budget it draws on depends on the
answer. `'registry'` is an address the installation's administrators chose — the core's closed
built-in registry or an ontology default (`properties.map_sources`) — and draws on the 16 global
slots. `'stored'` is an address a record's editor wrote, so its host is the editor's choice:
those requests ALSO count against a stored-address budget of 8 slots (queue of 32), taken before
the global one, so the hosts an editor picks can never hold every global slot — the registry's
origins always keep at least 8, whatever an editor writes. The field is required (a route cannot
forget it), closed to those two values, and applies to every hop of a redirect chain.

**Who is waiting.** A request also names `holder` — required, an opaque non-empty name of at most 64
characters that the ROUTE established (`user:<id>` from the session, never anything the client sent) — and
it holds one of the holder's own places FIRST of all (before the origin's), with a line of its own (512, so a
4K viewport of two layers waits whole). Which place depends on who chose the host:

- A `'stored'` request holds one of `INTERACTIVE_MAX_STORED_PER_HOLDER` (3) slots across ALL the holder's
  stored hosts. The stored budget bounds what editors as a CLASS can take; this bounds what ONE editor can:
  two slow hosts of a person's own (4 per origin x 2 would be the whole stored budget) hold three slots, not
  eight.
- A `'registry'` request holds one of `INTERACTIVE_MAX_REGISTRY_PER_HOLDER` (4, as many as an origin has
  slots) places at THIS origin, per holder and per origin. An origin an administrator chose is the one
  EVERY viewer of the installation draws on, and its queue is first in, first out: without a bound per
  person, one person's 300 tiles filled its whole queue (256) and the next person's single tile was
  `queue_full` until they drained. With it a person is at most four deep in the origin's queue, the rest of
  their view waits in their own line holding nothing, and a newcomer is served after at most four of
  anyone else's requests however big the other's view is. A lone viewer is not slowed (four places is
  the origin's own concurrency), and a person's two layers on two origins each have their own four.

The holder's place comes first so that a person at their limit waits holding nothing — they park no origin
slot another reader of the same source needs, no origin queue position and no shared slot. Each holder key
exists in its limiter only while that person holds or awaits a place (the same self-draining as every key;
`module_state_tripwire` lists the two, the only keys that ARE identity, deliberately). What stays open:
several sessions that may edit records can still fill the stored budget between them (that takes several
accounts, which is the cost of the attack and not a way round the cap), and many people at once can still
fill an origin's queue (65 people at four places each fill its 260): a bound per person is not a bound on a
crowd.

**What the one core route owes, because the door cannot do it for it** (the contract it is
held to; its `INTERACTIVE_IMPORTERS` row says what it does for each clause, and it lands with
its own gates): its request names a STORED source (or an ontology default, or a closed built-in id) and never a URL a
client wrote; it builds the upstream URL itself and passes `hosts: [that host]`; it names `addressFrom`
truthfully (an editor's stored address is `'stored'`, whatever the route does to it; only the
built-in registry and an ontology default are `'registry'`) and may give a stored address a
shorter `timeoutMs`, since a slow host holds its slots for the whole hop; it checks
the session and the read permission BEFORE it fetches or answers from a cache; it checks the
exact media type and its own byte cap on the answer (the door's ceiling is only the outer
bound); it forwards no cookie or credential in either direction; it relays no prefetch; it
wraps the call in `runWithJobSignal(request.signal, …)` so a client that went away frees its
queue place and its slot — the door REFUSES a call with no job signal in scope; it maps EVERY
failure of the door (`harvest.*`, `security.*`, `rate.limited`) to ONE typed refusal for its
reader, so `details.site`, `details.content_type`, the status and the timing never make the
route an oracle for which port or service answered; it passes the origin's spacing on every
request to that origin (*Spacing* above); and it exports a route handler, never a function that
takes a URL (the census does not follow wrappers). A provider's own terms — a mandatory spacing,
an attribution, a minimum cache lifetime — are the route's registry's: the spacing is passed in
as `minIntervalMs`, and the lifetime is followed from the answer's `cache-control` / `expires` /
`age` / `date`, which this profile exposes; the door enforces what it is told.

Stated limits. The limiter bounds an origin, the installation and — per holder — the stored slots a person
holds and the places they take in a registry origin's queue; it does not bound how many calls a person
STARTS over time. (The one core route puts a budget per person in front of the door for exactly this, §3.2:
a token bucket counts starts, the holder's places count slots and queue positions, and neither can do the
other's job. The bucket's burst, 400, is larger than an origin's whole queue, 260: it is the holder's line
and not the bucket that keeps one person's burst out of everyone else's way, and the burst is larger than
the line only on purpose, so a person's own storm is paced by their line and ended by the wait ceiling.) A holder's cap is not a guarantee against a crowd: several accounts that may edit records,
each with a slow host, can hold the eight stored slots between them, and every other stored source is
`rate.limited` meanwhile — the stored starvation is installation-wide, not per origin, and takes as many
accounts as the cap allows slots (three for eight) — and sixty-five people loading a map of one registry
origin in the same moment fill its queue. A stored hop's budget is the route's `STORED_TIMEOUT_MS`
(6 s), not the profile's 10 s default, so a slot an editor's tarpit holds is held for 6 s at most. What
they cannot touch is the other half of the global budget: the registry's and the ontology defaults'
origins keep their eight slots. A request keeps its shared slots while it waits out its spacing, so an origin with a spacing can
hold up to its four slots that way for as long as the one ceiling allows. Only the scheme's own
port is reachable: a provider on another port is not relayed, and serving one is a change to
this door, not to a route. Its timers (the idle-key drain, the wait ceiling, the spacing pause)
are unref'd, and the last two are cleared however the wait ends.

### 3.2 The one core route: the map tile proxy

`GET /dedalo/core/api/v1/map_tile` (`src/core/api/map_tile.ts`, its only export `handleMapTile`) is
the route §3.1 exists for. Its manual page is `docs/core/system/map_tile_proxy.md`; this section
pins how it pays each duty listed above, because the census checks the row and the gate checks the
behaviour:

| Duty (§3.1) | How the route pays it |
|---|---|
| names a source, never a URL | the query is a closed grammar (`geo/tile_proxy/tile_request.ts`): three source shapes (stored `{section_tipo, section_id, component_tipo, source_id}`, ontology default `{…, default_id}`, built-in `{…, builtin}`) x two views (`z/x/y`, or `bbox/width/height` for WMS). No key carries an address, a host, a header or a parameter of the provider's |
| builds the address itself | `geo/tile_proxy/upstream_url.ts` re-validates the WHOLE source with the validator the save gate runs (`validateMapSource`), substitutes only integers into an xyz template, and builds the WMS query through `URLSearchParams` after fixing `service=WMS&request=GetMap`; `layers: "a&service=WFS"` written past the save gate is refused at fetch time. The bbox of a tile is computed by the server in the source's CRS, the axis order reversed for WMS 1.3.0 with a geographic CRS |
| session and permission BEFORE the fetch and before the memory | session (`sessionPrincipalFromCookie`), the section grant and the component grant of the section AS ADDRESSED (`doorComponentGranted`, the quiet predicate of `doorComponentAllowed` — see below), the ontology's tie of component to section and model (`tipoBelongsToSection`, virtual-aware), the record scope (`principalCanAccessRecord`) — all in `geo/tile_proxy/tile_source.ts`, all before the address exists. The route is a classified READ DOOR (`READ_DOOR_EXTRA_DOORS`, posture `component`, probed by `read_door_acl_native`) |
| one refusal for unknown and forbidden | every gate answers `404 resource.not_found`; the gate asserts the bodies are byte-identical across twelve ways of not getting a source |
| `addressFrom` truthful | a stored source is `'stored'`; a default and a built-in are `'registry'` (gated by watching the budgets while a hop is held) |
| the origin's spacing on every request | `relayRequest(resolved, upstream, termsFor(host))` (`geo/tile_proxy/relay_request.ts`): the terms belong to the ORIGIN, so a stored source on a registry host is owed what the registry host is owed. No registry provider states a spacing today (the rows carry `minIntervalMs: 0`), so the route's own gate cannot see the field; `relay_request` is its own module precisely so `map_tile_geometry_native` can build the request with a synthetic non-zero `ProviderTerms` and push two of them through the REAL door under a fake clock: the second start is spaced from the first by exactly `minIntervalMs`, and a request built without it is not (mutation-checked) |
| the request's signal | `runWithJobSignal` over the call, supplied by a FLIGHT (`geo/tile_proxy/tile_flights.ts`): the call runs under a signal of its own that is aborted when the LAST viewer waiting on it has gone, so a viewer who panned away frees the queue place and the socket unless another still needs the call (gated, both halves) |
| one typed refusal for every failure of the door | `external.transport` (503, operator disclosure): `harvest.*` and `security.*` of the door, a provider status that is not "no such tile", an image whose bytes are not its type or whose declared size is past the limits. The door's own `rate.limited` is the exception: it is capacity, not a failure, and answers `429 rate.limited` (below). The gate asserts no host, address or token appears in the body. A provider's ANSWER is not a failure of the door (`geo/tile_proxy/tile_outcome.ts`): 404, 410 and a 2xx with no content type are `absent`, a 2xx of another media type is `not_an_image` — both the uniform `404 resource.not_found`, counted and never a 5xx — because a source rarely covers a whole viewport and a healthy provider must not read as an outage |
| exact media type, own byte cap | the four image types, matched exactly (a WMS source: the format it declared), AND the bytes must begin like the type (`image_bytes.ts`); 2 MiB per image |
| forwards no cookie or credential | the door sets the request headers (`Accept`, and `Referer` only where `ProviderTerms.sendReferer`); nothing of the browser's is forwarded and only the freshness headers of the answer are read |
| relays no prefetch | `Sec-Purpose: prefetch` / `Purpose: prefetch` and `Sec-Fetch-Site: cross-site` are refused before any work; the route fetches the tile asked for and never a neighbour |
| exports a handler and nothing that takes a URL | `handleMapTile` is the module's only export (the row's `handlers`) |

What the route adds on top of the door's duties (each gated by `map_tile_proxy_native`, its pure half by `map_tile_geometry_native`):

| Addition | How |
|---|---|
| a share of the provider per PERSON | `geo/tile_proxy/principal_budget.ts`: a token bucket per user id (burst 400, refill 5 a second: a viewport is asked all at once, up to 160 tiles on a 3840x2160 display, two layers 320), spent only by the request that STARTS a call to the provider (a memory hit and a joined call cost nothing, and neither does a call the provider never heard of — one the door refused for its own capacity on its FIRST hop, or one every viewer who needed it LEFT while it waited for its place, which a pan or a zoom does to every tile still queued: `refundUpstreamToken`, the first decided by the busy outcome's `reachedProvider`, the second by `stoppedBeforeAnyRequest`, which is false for a stop mid-request and for a stop in the second hop of a redirect chain; a capacity refusal (`queue_full` / `wait_exceeded`) of a redirect's LATER hop stays charged too — the first hop reached the provider (`refusedAfterRequest` tags it `after: request_sent`); a provider's "no such tile" IS charged, it was a call), checked after every gate and BEFORE the request takes a place in the door's queue. Past it: `429 rate.limited` with `Retry-After`. The origin and installation caps protect the provider's capacity; this protects the installation's STANDING with it (a script walking thousands of tiles is bulk scraping under OpenStreetMap's policy and risks the whole installation's address). It counts call STARTS, not how long a call holds a place: keeping one person's view out of everyone's way is the door's per-holder places (§3.1 *Who is waiting*). The map is a module Map in `module_state_tripwire`, self-draining and bounded |
| capacity is BUSY, not a fault | the door's own `rate.limited` (an origin's queue full, a start that cannot happen within the wait ceiling — which is also what an origin held off by a provider's `Retry-After` looks like) is `busy` in `tile_outcome.ts`: `429 rate.limited` with `Retry-After: 2`, counted as `map_tile_busy` (the person's share is `map_tile_rate_limited`), one operator line per source per minute (`why=upstream_busy door_reason=queue_full` or `wait_exceeded`), never `map_tile_relay_failed`, never reported as a failing provider. The page asks again twice (`component_geolocation.retry_refused_tiles`). Gated by a route test that fires 44 distinct tiles at a held peer and lets the person's line reach its wait ceiling: four are served, forty are busy, none a fault, none charged |
| one person's view is not everyone's line | the door's per-holder places at a registry origin (§3.1 *Who is waiting*), driven from the route: one person's 300 tiles at OpenStreetMap hold four places in its queue and wait in their own line, and a second person's single tile is served after ONE turnover (the first gate to fail against an uncapped holder) |
| "no such tile" is told to the BROWSER, not remembered | the proxy keeps NO refusal (the maintainers' decision for the cache: successful image responses only; `tile_cache.ts` exports nothing that could remember one, and the gate pins the export list): a provider's `404`, `410` or empty answer is `404 resource.not_found` with `Cache-Control: private, max-age=120` and `Vary: Cookie`, so the one browser that asked does not ask again for two minutes (`freshness.ts` `absentCacheControl`). Every ask that reaches the server is a provider call, charged like any other. The `max-age` on that 404 is NOT in the maintainers' decision and is recorded as open in `WC-2026-11-06-map-tile-proxy` |
| an expired tile is revalidated | `geo/tile_proxy/validators.ts` + `tile_cache.ts`: a tile that came with an `ETag` (an entity-tag in RFC 9110's grammar) or a `Last-Modified` (a date the runtime reads), neither over 256 characters, is kept as a STALE entry for at most a week past its freshness and is not served; the route asks the provider with `If-None-Match` / `If-Modified-Since` — the validators THAT provider gave for THAT address, nothing else — and a `304` renews it by the freshness the `304` states (RFC 9111 §4.3.4), a `200` replaces it, a `404`/`410` drops it, a fault leaves it for the next try. A `304` is believed only for a request that carried a condition (`tile_outcome.ts`); otherwise it is a fault. A stale entry is the same Map slot as any other, so the byte and count bounds are the only bounds |
| an image that declares a decode bomb is not relayed | `geo/tile_proxy/image_bytes.ts` reads the width and height from the header of each type (PNG IHDR, GIF logical screen, JPEG start of frame, WebP VP8/VP8L/VP8X); over 2048 px a side or 4 Mpx, or no readable size, is a fault (`image_too_large` / `not_the_image_it_claims`). The byte cap cannot make this check: two megabytes of PNG can declare 30 000 x 30 000 pixels, and the browser decodes in full whatever the tile is drawn as |
| a browser does not outlive an edit by a day | `freshness.ts` `browserCacheControl(…, stability)`: a tile of a source that is data (a stored source, an ontology default: edited, updated or restored without the proxy URL changing) is told to the browser for at most five minutes; a built-in's, which changes only with the engine, for at most a day |
| a refusal to read a map is not a log line per request | `geo/tile_proxy/tile_source.ts` asks the component grant through the QUIET predicate (`doorComponentGranted`, the predicate of `doorComponentAllowed` without its `[frontier] REFUSED` line and request notice): the refusal is counted (`map_tile_denied`) and written once a minute per person, naming the user and no tipo |
| one call per address | `geo/tile_proxy/tile_flights.ts`: a request for an upstream address already in the air JOINS that call instead of starting its own, keyed by the address, joined only after the gates. A shared outcome is a shared failure too; the next request asks again |
| a log that cannot be flooded | `geo/tile_proxy/tile_log.ts`: what a caller controls (a zoom outside a source, a view it does not take, a provider's "no such tile") is COUNTED, never logged; a fault, a stored source that no longer validates and a person held to their budget are one line per distinct line per minute, the repeats counted in `map_tile_log_suppressed`. A viewer who went away reports nothing |
| geographic-CRS WMS tiles from zoom 8 | `GEOGRAPHIC_TILE_MIN_ZOOM` (`tile_geometry.ts`): the plate carrée crop a service returns for a geographic CRS is misregistered against a mercator tile by more than a pixel below it. The gate MEASURES the error from the geometry (about 47 px at zoom 2, 12 px at 4, 3 px at 6, 0.78 px at 8) and pins the floor to the first zoom under a pixel; the client's mirror of the number is checked against the server's |
| a source that saves is a source that draws | `checkSourceUrl` refuses an explicit port other than the scheme's own, the door's rule: the save, the import and the fetch-time re-check agree with the door |

THE MEMORY (`geo/tile_proxy/tile_cache.ts`) is the route's only state and follows the engine's cache
rules: a module Map listed in `module_state_tripwire` with its lifecycle, keyed by the UPSTREAM ADDRESS
(no user, session, language or record: it is the question asked of the provider), holding only verified
image answers for the provider's own freshness (`freshness.ts`: `s-maxage`, `max-age`, `Expires` less
`Age`; `no-store`, `no-cache` and `private` never kept; clamped to a week and at least ten seconds),
bounded BY BYTES (32 MiB, 512 KiB per entry, no entry costing less than 1 KiB) AND BY COUNT (16 384),
the oldest evicted first, one entry at a time, with a running byte total so that admitting a tile
costs the same however full the memory is (a stored source hosted by an editor can answer a valid
70-byte image for every `{z}/{x}/{y}`; the first draft rescanned everything held on every admission:
0.65 ms of blocked event loop per new tile with 70 000 entries). It is shared between viewers on
purpose, and safe because the route consults it only after every gate — the gate proves a denied
caller is refused with the tile sitting in it. It holds successful image responses ONLY: no refusal, no
"there is no such tile", no failure. An expired tile with a validator is revalidated, not fetched in full
again (the row above).

THE REGISTRY (`builtin_sources.ts`) is code: a provider enters it only with its terms read and cited
in the file (OpenStreetMap's tile policy; the IGN's CC BY 4.0 licence and the attribution its own
GetCapabilities states), and an origin's terms (Referer, default lifetime, spacing) are owed to that
origin whoever's record asked. A row lists the conditions its provider's terms set and says, for each,
whether the proxy meets it — and where only some installations can, which. OpenStreetMap's policy
"generally does not recommend" a caching proxy and allows one that: sends a clear, contactable
`User-Agent` identifying the service and does not tunnel all clients behind one anonymous identity (MET
where the installation has a public origin: the interactive profile's `User-Agent` is
`dedalo/<release> (+<that origin>)`, naming the installation as contact, §3.1 *Identity*; NOT MET where
it has none: the shared `dedalo/<release> (+https://dedalo.dev; heritage cataloguing)`), keeps the Referer (MET and NOT MET
on the same condition), honours the caching headers or keeps a tile seven days (MET), uses conditional
requests on expired tiles (MET: the row above), and relays no prefetch and no bulk download (MET). An
installation with no origin an outside machine could reach has only the shared identity, the generic
proxy identity the policy forbids, so it does NOT relay OpenStreetMap (decided 2026-11-07,
`WC-2026-11-06-map-tile-proxy`): ONE rule (`geo/tile_proxy/direct_tiles.ts`) both refuses the route for
that host (a stored source or a default on it included; before the memory, so no kept tile is served)
and lists the built-in in the geolocation context's `features.tile_direct`, from which the client loads
`tile.openstreetmap.org` directly with the viewer's own `User-Agent` and `Referer` — the one exact host
the page's `img-src` admits for it. Documented to the operator in `docs/core/system/map_tile_proxy.md`.
DARE (no confirmation that a tile may be relayed),
Catastro (its licence forbids distributing the original information untransformed), Carto, ArcGIS and
Google are not in it.

THE SEAMS the route's tests need (the resolver and the socket of the door, the limiter's clock) are the
geo outbound scope's (`geo_services/geo_seams.ts`, §2): only a gate can open it, so production passes
none and no caller can choose a transport.

## 4. `fetchPinnedHop` — the one pinned primitive

It runs `assertPublicUrl` ITSELF, so it can never be called on an unvetted
target; refuses zone ids; pins; sends with `redirect: 'manual'`; composes its
deadline with the running job's signal (unless detached, for a fetch shared by
many jobs); on a CONNECT-level failure tries the next vetted address — a POST
only when the failure proves nothing was sent (a refused or unreachable route,
never a reset: RFC 9110 §9.2.2, a re-sent `transcribe` is a second, billed job),
and a GET of a caller that sets `resendOnlyUnsent` (a provider that counts
requests: the geo services) by the same rule —
never after an HTTP answer; and returns `location` ONLY for a 301/302/303/307/308
that carries one — that body is cancelled unread, every other status is read
normally. It applies NO other policy: scheme, downgrade, host allowlist,
robots, pacing and the hop limit belong to its caller.

That is why it has exactly ONE production IMPORTER, the harvest redirect loop
(`src/core/harvest/follow.ts`). A second importer is a second redirect loop, and
the first one to forget a per-hop rule is an open redirect into the harvester.
Inside the guard, `fetchGuardedText` uses the hop ONCE and refuses any
`location` it hands back — no loop, so not a second redirect-follower; it is how
the single-call door connects to the address it vetted.

The loop itself, `followVetted`, is held to the same rule one level up. It
vets every hop's URL, but robots.txt and pacing are whatever its caller passes
as `beforeHop`, so it has exactly TWO callers: `harvestFetch` (robots, then the
paced turn) and the robots.txt fetch (which IS the robots check, unpaced). A
tool imports `harvestFetch`, never the loop. (The interactive profile of §3.1 runs
through the SAME call inside `harvest.ts` — its `beforeHop` is the limiter's slot —
so it is not a third caller, and it has no loop of its own.)

## 5. What is not a door

A few sites dial out without the guard because they cannot use it: a unix
socket on this machine, a loopback health poll of a child this process spawned,
an operator-configured endpoint that is legitimately private (a model sidecar
on the institution's LAN), and the operator-configured downloads still being
moved onto the guard. They
are a SHRINK-ONLY burn-down list with a reason each, in
`test/unit/ssrf_one_guard_tripwire.test.ts` (`EXEMPT`) — that list is the
record, not this file. The paired agent channel is not on that list: it is a
door with its own policy (§2.1, `src/core/publication_host/transport.ts`),
registered as one in both gates.

**The dependency installs.** Two engine paths run the PINNED Bun (`process.execPath`)
`install --frozen-lockfile --production`, which fetches packages from the npm registry:
the code updater's own install in the quarantine (`installDepsReal`,
`src/core/update/code_update.ts`) and the Publication API v2 build
(`installV2DepsReal`, `src/core/publication_host/api_bundles.ts`, which also passes
`--linker hoisted --ignore-scripts`). The maintenance panel's publication-host kit
(`src/core/publication_host/kit_build.ts`, root-only `build_kit`) installs the agent
package's production dependencies through that SAME `installV2DepsReal` — the same argv,
environment, cache and refusals, from the agent's verified `package.json` + `bun.lock` (a
release without the lockfile is refused before the child starts) — so it adds no door and no
second install path; it is the v2 build's egress with one more lockfile. They are child processes, not engine sockets, so no
guard can stand in front of them. What bounds them is the lockfile: every version and
integrity hash is the one the verified release shipped. The v2 build refuses a release
without `bun.lock` before the child starts (Bun accepts `--frozen-lockfile` with no
lockfile and floats every version); the updater's install has no such check yet. The v2 child runs with a minimal environment
(`v2DepsInstallEnv`):
- it passes through only `PATH`, `TMPDIR` and the standard proxy keys;
- its `HOME` is the build dir and its cache a shared dir under the build root;
- it gets no engine secret.

`test/unit/publication_host_api_bundles_native.test.ts` holds that environment to the exact
key set. The registry this egress reaches is the release's own `bunfig.toml` (verified
input) or Bun's default; no operator registry override is passed.

## 6. The gates

| Gate | Enforces |
|---|---|
| `test/unit/ssrf_one_guard_tripwire.test.ts` | No outbound socket outside the guard except the burn-down list and the private agent channel, which is a registered door (`PRIVATE_CHANNEL_DOORS`), never an `EXEMPT` row; `fetchPinnedHop` has one production importer and `followVetted` two; `agentRequest` is held only by the publication-host client (`AGENT_CHANNEL_IMPORTERS`, exact both ways) and `dialAgent` by no production module; `interactiveFetch` (§3.1) is held by no tool and by a core module only through an `INTERACTIVE_IMPORTERS` row (exact both ways, at most one: the map tile proxy, §3.2) whose `{ reason, gate, handlers }` are CHECKED — the route's runtime exports are exactly the handlers and its own native gate exists, imports it, names them and carries real tests — and `harvest.ts` itself exports an exact list (no `harvestWith`, no profile builder) with `followVetted` referenced once, as a call; no tool holds a raw door. The importer census follows import BINDINGS through re-exports, not spellings. A tool holding ANY outbound door (`harvestFetch` included) reads no error's `.message` (the guard's names the refused address — report `toErrorBody(toDedaloError(error))`); no module but the guard spells an address reason (read them with `isAddressRefusal`). The ATTACKER-AAAA TRUTH TABLE drives every IPv4 carrier (mapped, NAT64, declared at every layout, local-use in every layout, IPv4-compatible, SIIT, 6to4, Teredo, discovered) × non-public/public payloads, special blocks, a first-hextet allowlist sweep and multi-record answers, under three discovery modes, through `assertPublicUrl` (resolved and literal), `isPrivateIp`, `isSafeLocalAsrUrl` (exemption on and off) and `claimedIpv4s`; a DECLARED local-use prefix (`64:ff9b:1::/48`, `/96`) keeps the transcriber with the exemption OFF equal to the guard and `claimedIpv4s` exactly the declared reading; the oracle is the test's own RFC 6052 encoder, and the mutations that must turn it red are recorded in its header. Outside `src/core/security/` a module imports a carrier primitive (`extractRfc6052Ipv4`, `packedInBlock`, `packBlocks`, `packCidr`) only by a reasoned, shrink-only census row (by import binding); that census cannot see a hand-rolled byte comparison, so every holder of ANY address byte primitive (`packIpv6`, `packAddress`, `ipInCidr` …) is registered as an `inbound` (client-IP allowlist) or `outbound` judge, and each outbound judge's exported predicate is DRIVEN through the truth table with every exemption off and must equal the guard (shrink-only rows). A module that parses addresses with no primitive of `ip_address.ts` is outside the census. The geo services (§2) are censused as the WRAPPER they are, not as a door: exactly one module of `src/core/geo_services/` (`call.ts`) holds a raw door and it is `fetchGuardedText` alone, its runtime exports are exactly `callGeoService`, that function takes exactly `(id, params)` (no seam is a parameter), and its gate exists, imports it, names the entry point and carries a real number of tests (`geoServicesProblems`, each refusal driven on a synthetic tree). The text door's test seams ride a scope (`geo_seams.ts`) whose opener `runWithGeoServiceSeams` is a door of the import-graph census seeded on its own: no file of `src/` or `tools/` may bind it by any route (named, renamed or namespace import, `export … from`, a barrel or forwarder inside the module, a literal `import()`/`require()`, a re-exported `const`), a non-literal `import()` in a file that names the seams module is refused, and so is a file that spells the opener without binding it (`geoSeamProblems`, every shape driven on a synthetic tree). |
| `test/unit/guarded_text_pin_native.test.ts` | `fetchGuardedText` connects to the address it vetted: a rebinding resolver gets ONE lookup and the socket the vetted IP (Host and SNI kept); a 3xx is refused unfollowed; a non-2xx, a stalled resolver and a failing socket are typed `security.outbound_failed`; a POST reset after sending is not re-sent to the next address (a refused one is, and a GET always unless the caller asked for `resendOnlyUnsent` — the geo services, whose slot is one request — which gives a GET the POST rule); a `URLSearchParams` body reaches the socket unchanged; an unsupported method, body or init key is refused before any socket. On BOTH text doors (`fetchBoundedText` against a loopback peer) a caller's `maxBytes` and the default ceiling end the read as `body_cap`, the stream cancelled, and a non-2xx is `HTTP <n>` with its body cancelled unread (a stalled or oversized error page included). On both doors a caller's `timeoutMs` ends a stall within an upper bound, and with none the 15 s default ends it at exactly 15 s (fake clock). On `fetchBoundedText`, as loopback outcomes: a 302 is refused typed with its `Location` never contacted, a closed port is `transport`/`connect`, and the running job's stop reaches the connect (`aborted`). On `fetchGuardedText` — the door translation and transcription take inside job lanes (PERF-11) — a socket that never answers is released by the job's stop as `aborted`/`connect`, long before the deadline. |
| `test/unit/outbound_fetch_tripwire.test.ts` | Every outbound call carries a signal and every fetching file declares its byte bound; each door's call closure applies what it claims (vetting, pin, shared reader, deadline, redirect mode) and the primitives are driven through their seams; every `fetchBoundedText` caller applies an address policy, and the ontology manifest client's one call dials the URL `assertConfiguredMasterUrl` judged; the private agent channel's one call dials `agentTarget`'s output and reads through the shared `readBytesCapped`. |
| `test/unit/external_outbound_tripwire.test.ts` | The external door is the only one under `src/external/`, in its order. |
| `test/unit/harvest_door_native.test.ts` | The harvesting door's rules, driven — and, by OUTCOME, the two guard pieces a spelling census cannot pin: no wait leaves an abort listener behind (`untilAborted`), and a `Retry-After` only `Date.parse` would read asks no wait (`parseRetryAfterMs`). The interactive profile (§3.1): the default path is unchanged (robots.txt still asked, the 3 s pace and its limits untouched by interactive traffic); no tool can select it (`harvestFetch` refuses a `profile` on the request or the deps, and the types carry none); it never asks robots.txt; its state is separate from the default queue in both directions; the per-origin, global and queue caps (the global queue driven to its bound across 145 origins), the stored-address share (four slow hosts of DIFFERENT editors hold 8 of the 16 slots and not one more, a registry burst is served meanwhile, the stored queue is bounded, a stopped or refused stored caller gives every place back, a redirect hop draws on the same budget, `addressFrom` is required and closed), the ONE wait ceiling over the queues and the spacing, and `minIntervalMs` hold — including with the global limiter saturated, where two spaced requests released together still leave one spacing apart; a start owes its spacing to the starts after it (mixed spacing pinned); a 429/503 `Retry-After` is honoured, clamped, fails newcomers fast, and holds a start already paused when it lands; the job's stop signal frees a queued, pausing or in-flight caller's place with no listener left and hands it on to the caller behind, and a call with no job signal is refused; every redirect hop is re-vetted, on the scheme's own port only (a stored `host:6379` and a redirect to `:8443` are `port_not_allowed`, the default profile untouched); GET only, two headers, exact media types, a required allowlist; the interactive answer carries `cache-control`, `expires`, `age` and `date` and a tool's does not. One person's places at a REGISTRY origin: 300 tiles of one holder hold four places and wait in their own line holding nothing, a second person's tile is served after one turnover, a person's two origins each have their own four, many people still fill the origin's queue (65 at four places each) and the next is refused, a person's line is bounded and theirs alone, its wait is the one ceiling, a stop leaves it at once and a stop in the second hop of a redirect chain says an earlier hop had been sent (the gate fails against an uncapped holder). A revalidation's two validators are accepted by the interactive profile only and a 304 comes back as the non-2xx it is. One person's cap on the stored slots: two slow hosts of one holder hold 3 slots not 8, a second person is served meanwhile, the same person's registry request is not under the cap, a person at their cap waits in a queue of their own holding no origin slot (another reader of the same host takes the free one), their wait is the one ceiling, their queue is bounded and theirs alone, a stopped request gives its place back; `holder` is required, non-empty and at most 64 characters. The interactive `User-Agent` is `dedalo/<release> (+<public origin>)` when the installation has one, and the shared identity otherwise — and for a hostile configured address (CR/LF, credentials, a path, a query, a malformed host name, an overlong value, a non-http scheme), with the request still sent; an IDN host is a contact in punycode — while the default profile's is unchanged. |
| `test/unit/origin_limiter_native.test.ts` | The per-key limiter (`origin_limiter.ts`), driven on a fake clock: the concurrency cap and FIFO queue, the bounded queue and wait, spacing owed forward (mixed spacing pinned) and reserved at the start rather than at the slot, the reservation of a caller who leaves given back, one ceiling counted from `since` across two limiters, back-off (including one that lands while a reserved start is pausing: it waits again with the order and spacing of the starts behind it kept, is refused when the back-off passes its ceiling, and still leaves at once on a stop), the stop signal at each wait (and in the instant a slot is granted) handing the place on, self-draining with ONE drain timer per key however many newcomers a back-off refuses (an overdue timer that never ran is replaced), independent instances, validated options; and, against fake global timers, that every timer it makes is unref'd and the ceiling's and the pause's are cleared however the wait ends. |
| `test/unit/map_tile_proxy_native.test.ts` | The map tile proxy (§3.2), driven end to end against a loopback provider through the door's seams, on a scratch `zztile` situation with five non-admin identities that differ in one grant each. The permission matrix: no session, a garbage cookie, a cross-site or speculative request, the component denied, the section denied, another project, an unknown source, an unknown record, another model's tipo, a geolocation of another section, an unknown default and built-in, a broken default — ONE body, byte for byte; the grant is read on the section as addressed (a virtual twin); a denied caller is refused with the tile sitting in the memory; the memory is keyed by the upstream address (two sources with one template share an entry); SSRF (a private literal and credentials stored past the gate, a redirect to an internal resolution, to another host, to a private literal and to another port, a stored address on another port); SVG, HTML and an image whose bytes are not its type; the byte ceilings (refused over 2 MiB, served and not kept over 512 KiB); a failing provider, a 429 holding the origin off; WMS parameter injection (a layer list written past the gate, every query attempt) and the exact GetMap query with its axis order; the provider's freshness, `no-store`, the floor and the origin's default; the response headers; the door's budgets (`addressFrom`), the client going away, and the Referer sent only where a provider's terms ask for it and only from an origin an outside machine could reach; what each kind of provider answer means (a 404, a 410, an empty 204, an exception report under a 200 and a failing provider are told apart, and the first three are quiet); each person's share (burst, refusal with `Retry-After`, a second person untouched, the refill, a memory hit and a gate-failing caller costing nothing); one provider call for identical concurrent misses (a gate-failing caller never joining, a shared failure, the call surviving one viewer leaving and stopping when the last goes); the log (forty failing tiles, one line; a zoom outside a source and a stored source failing today's rules, counted or said once); a geographic-CRS tile below zoom 8; registration in the server and the read-door census. Mutation-checked: skipping the component grant, labelling every address `registry`, skipping the byte check and widening the redirect allowlist each turn it red. The route's registry rows owe no spacing, so "the origin's spacing on every request" is gated in the pure half (below), not here. Added by the fix round: an image whose header declares a decode bomb or no size is a fault in all four formats (and a retina tile and the largest free image pass); a provider's "no such tile" is NOT remembered by the proxy (every ask is a charged provider call), tells the browser it may remember it for two minutes (with `Vary: Cookie`), tells a caller who failed a gate nothing and is never a fault's memory; an expired tile with a validator is revalidated (a 304 renews, a 200 replaces, a 404 drops, a fault leaves it, a 304 nobody asked for is a fault, the revalidation is charged and a caller who fails a gate never triggers it, mutation-checked against sending no validator); a stored source or a default is told to a browser for five minutes and a built-in for a day; a refusal to read a map writes no `[frontier]` line (25 requests as two people: zero, then one `[map_tile]` line each) and is counted; the 160 tiles of a 4K display of two layers load whole; what the door cannot take in time is `429` busy with `Retry-After`, counted apart, one operator line, no fault, not charged, and fine on the next ask; a same-host redirect whose second hop the door refuses for capacity is busy and stays charged (mutation-checked against an unconditional refund); one person's 300 tiles at OpenStreetMap hold four places and a second person's tile is served after one turnover (mutation-checked against an uncapped holder); tiles whose viewers left while they waited for their place were never sent and are not charged (mutation-checked against no refund); one person's two slow stored hosts hold three slots while another person is served; the interactive `User-Agent` names the installation as contact (`+<origin>`; the shared identity for an unreachable one); the identity is not part of the cache key, and ONE rule for both headers: an IDN address yields both, in the same punycode origin. The identity rule (2026-11-07): over the one table of configured origins shared with the pure half (`test/helpers/public_origin_table.ts`), OpenStreetMap is relayed with `dedalo/<release> (+<origin>)` and `Referer: <origin>/` or refused `external.disabled` with no provider request — never relayed under the shared identity; IGN is still relayed under the shared identity with no `Referer` (a configured address with credentials and a path included, which yields no contact); a tile kept while identified is not served once unidentified (and serves again once identified, from the same entry); a stored source on OpenStreetMap's host, its root-dot spelling, a name under it and its other domains (`tile.osm.org`, `tile.openstreetmap.com`) are refused too, another stored host is not; a caller who fails a permission gate, or asks a zoom the source does not take, gets the uniform not-found, not the identity refusal. |
| `test/unit/map_tile_geometry_native.test.ts` | The pure half of the proxy, with no database and no network: the closed request grammar, the tile geometry (closed-form Web Mercator squares, geographic corners) and the WMS axis order, the upstream address (xyz substitution, the WMS query in order, a hostile stored value refused again at fetch time), the freshness rules and their clamps, the memory bounded by bytes and by count (oldest first, an oversize entry served and not kept, an overwrite counted once, a tiny tile costing the floor, the running total equal to the arithmetic of what is held, and an admission whose cost does not grow with the memory, mutation-checked against a per-admission scan), what a provider's answer means (`tile_outcome`), the request handed the door driven through the real door with a synthetic non-zero spacing (mutation-checked), the per-person budget and the flights board (pure halves), the log's window and bounds, ONE derivation of the origin the installation tells a provider (the tile proxy's Referer, the geo services' User-Agent and the interactive door's contact User-Agent over one table of configured values: the exact bytes of each header, and the origin read back out of each byte-equal or absent from all three; over the same table, the proxy withholds OpenStreetMap exactly where there is no origin and `directBuiltinIds` lists it then and only then, OpenStreetMap is never relayable while the contact identity is the shared one, IGN is never withheld), the measured misregistration of a geographic-CRS tile, the image signatures and the built-in registry (exactly the providers whose terms were verified, frozen to its leaves, its rows passing the stored-source validator). Added by the fix round: the size an image declares is read from each type's header (PNG, GIF, JPEG past an APP segment holding a thumbnail, WebP lossy, lossless and extended) and a bomb or a header with no size is outside the limits; the browser's freshness cap for a source that is data and the "no such tile" `Cache-Control` (a constant: the proxy remembers no refusal, and the memory module's export list is pinned so that it cannot); revalidation (a stale tile with a validator waits a week at most, in the same Map slot, a renewal replaces it in place and a tile with no validator is dropped on the ask; the ETag / Last-Modified grammar and the conditional headers made of them; a 304 is a tile only for a request that carried a condition, renews by what it states and keeps the validators it does not restate; which stopped calls never reached the provider); the door's `rate.limited` is busy (a provider's 429 is still a fault); the request carries the holder; the table's rows: canonical spellings of one origin (case, default and zero-padded port, trailing `/` and dot, `HTTPS://`, `https:`, an IDN host as punycode), the canonical bound (100 characters is an origin, 101 is not; a >100-character configured value that canonicalizes short is that origin — the bound is on what is sent, not on the raw value), unreachable hosts (loopback, private, `.arpa` incl. `in-addr.arpa`/`ip6.arpa`/`home.arpa`, `.alt`…), malformed names (`.museum.org`, `foo..org`, `-.org`, an underscore, a 64-character label) and unclean values (credentials, a path, a query or fragment even empty, CR/LF, NUL, a tab, a trailing space, a non-http scheme — `ftp:`, `ws:` and `wss:` too, refused by the one scheme check alone, mutation-checked —, an explicit port 0, and an unset `DEDALO_HOST` beside a protocol that carries a host: `publicOrigin`'s `localhost` fallback is never an identity) — none of which reaches any of the three headers. |
| `test/unit/module_state_tripwire.test.ts` | Among its other censuses: EVERY site that can mint a per-key limiter (`createOriginLimiter` / `OriginLimiter` referenced outside `origin_limiter.ts`: a call, `new`, `extends`, an alias, a namespace member, a table, an array, `fromEntries`, a static field, a wrapper, a default export — Babel AST, by binding) has a row with its lifecycle (the interactive profile's five, the two per-holder ones being the only keys that are identity, deliberately); a re-export or a dynamic load of the limiter module is refused outright; the detector is driven on synthetic text for each shape. |
| `test/unit/geo_services_native.test.ts` | The geo services (§2), driven through the text door's seams against a loopback peer — no real network. The table is closed and consistent (the exact service set, frozen to its LEAVES — every row, tuple and parameter list walked, a write to a row throws, no RegExp reachable —, no parameter shadowing a fixed one, every ceiling finite, every origin's back-off longer than its wait ceiling, every queue able to fill with instantaneous calls inside its wait) and every origin, path, ordered query, response ceiling, deadline, `Accept`, attribution, answer lifetime and pacing number is pinned as a LITERAL (none is read from the row it checks); no configuration key moves an endpoint (the module imports nothing of `src/config/`, reads no environment, imports a closed list of modules per file, and the public origin it can see moves the User-Agent and nothing else). The request names no address: an id outside the table (a URL, a prototype key, another case), an unknown key (a URL, a header, a fixed parameter, `__proto__`), a missing or malformed value, a failed cross-check (an inverted box, a pixel outside the image, a box over the ceiling, EPSG:4326's swapped axes) are `request.invalid_data` with no socket and no limiter slot taken; a value full of `& # = / @` stays one value of its own key; the built address is checked against its table row. A box is accepted AT its ceiling and refused one step over, per service and per unit of the CRS. Every service is driven end to end (the pinned address on the wire, its fixed parameters then the caller's in table order, the socket pinned to the vetted address with the real name kept for Host and SNI, the identity header, no cookie or `Referer`). Answers are checked against the contract (`external.protocol`), a search that finds nothing is an empty result and a question with one answer is `external.not_found`. Free text is refused before it is normalized (a 50,000-unit run of combining marks in reverse canonical order is refused in under 100 ms; the tightest string that normalizes into the window is accepted, one unit over is not; the 4x bound is checked over every code point of the runtime's Unicode tables). Failures are typed and leak no address, host or query: 404/410 not found, transient statuses `external.http_status` (retryable), every other 4xx `external.bad_config` (not retryable), 429/503 with `retryAfterMs` AND a back-off after which a newcomer to that origin is refused fast, on EVERY origin (another provider unaffected), a redirect never followed, the byte ceiling of every service exact (a body of that size is read, one byte more is `external.too_large`), a stalled provider at every service's own deadline to the millisecond (fake timers), an address the guard refuses (`external.blocked_host`) against a name that does not resolve (`external.transport`, reason `dns`, retryable — every refusal reason of the guard classified). Pacing: spacing between starts is the origin's term across its services, the rate holds ON THE WIRE for an origin with one call in flight (a slow lookup before the first call and a fast one before the second, measured at the moment each connection opens, after a failure and after a stopped call too), one slot is ONE request at the provider (a reset after the request left is not sent to a second address, for every service, and the slot still rests; a refusal that proves nothing was sent still moves on), origins are independent, calls in flight never exceed the cap, the queue is bounded, the wait ceiling is driven (with calls that take time the fourth Nominatim caller starts AT 6 s and is served, one millisecond more per call and it is refused `wait_exceeded`; a queued caller's ceiling timer is armed with the table's wait and refuses that caller alone), a stopped job leaves the queue and no slot is lost, the state is closed and self-draining with one drain timer per origin across 200 refusals. Identical calls in the air are ONE call (a re-send takes no queue place and no second provider request, each caller gets an answer of its own, a failure is shared, nothing is kept after the answer); a stopped caller leaves its own wait and the call goes on for the others, and is cancelled, queue place and socket and slot included, only when the last one has gone; a call with no job signal in scope is not refused. The answer memory: only Nominatim keeps answers; an identical question inside the hour is answered with no flight, slot, wait, socket or request, each caller with an answer of its own; it lives exactly as long as the table says (one millisecond before the hour, served; at it, asked again); "nothing there" is kept, a failure, an off-contract body and an over-limit entry are not; it is bounded by bytes (key and overhead counted, the oldest evicted first). The identity header carries the origin only when a provider could reach it (loopback, private and reserved addresses, single-label names and `.local`-style suffixes are left out), never a person's address, and an unsafe value is left out whole, not repaired; the module's only runtime export is the entry point and it takes no seam. |
| `test/unit/external_transport_native.test.ts` | The external door's order (`EXTERNAL_SPEC.md` §5) — and the same `Retry-After` outcome at that door. |
| `test/unit/publication_host_door_tripwire.test.ts` | Only the agent channel loads an agent's TLS material (`readHostTls`, by binding) and spells the agent's base path; `rejectUnauthorized` only there and only `true`, no `checkServerIdentity`; the door's one call (AST): `target.url`, redirect `manual`, a signal, the shared reader; the door is registered in this file and both outbound tripwires. It also holds the docs to code: this file's door count equals the §2 table, §2.1 and this row exist once, §5 names the door module, every repo path a `PUBLICATION_HOST_SPEC.md` §8 "Built" row names exists, and the operator page's pair commands use the CLI's verbs, flags and invoking user. |
| `test/unit/publication_host_transport_native.test.ts` | §2.1, driven against loopback agents with an in-test PKI: mTLS with the pinned CA and the registry host as identity, the unix socket, the unix socket's filesystem check (`socket_perms`: a tight parent, a trusted owner, every ancestor on the path as written and on its realpath, a sticky `/tmp`-style squat refused), the closed route table and its closed per-route query grammar, a 3xx refused unread, deadline, idle bound (a caller may only lower it: zero, fractional, above the 30 s ceiling or the request deadline refused before any socket), byte ceiling, a streamed body, the bearer grammar shared with the secrets store, a refused stored bundle typed as unconfigured, `NODE_TLS_REJECT_UNAUTHORIZED=0` changing nothing, no secret in any failure, and the proxy residual's three canaries (`HTTPS_PROXY` proxies a TCP agent, `HTTP_PROXY` alone does not, a unix-socket agent never is). |

The four tripwires' and `guarded_text_pin_native`'s full rows are in
`engineering/TRIPWIRES.md`; the other `_native` gates are behavioural
suites, not index rows.
