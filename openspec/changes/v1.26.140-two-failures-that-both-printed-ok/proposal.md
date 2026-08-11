# v1.26.140 — Proposal: two failures that both printed OK

Two unrelated reports, one shape: something failed, and the thing watching it said fine.

---

## 1. The updater threw on an empty file and reported the sync as done

Reported 2026-08-11 from a Windows machine running `scripts/update.ps1`:

```
[ OK ] Skills synced (ownmind-memory + ownmind-upgrade)
以 "3" 引數呼叫 "Replace" 時發生例外狀況: "值不能為 null。參數名稱: input"
  於 C:\Users\...\.ownmind\scripts\update.ps1:176
不可在值為 Null 的運算式上呼叫方法。
  於 C:\Users\...\.ownmind\scripts\update.ps1:180
[ OK ] Upgrade rules synced to detected AI tools
```

### Root cause

`Get-Content -Raw` returns `$null` for a zero-byte file, not `''`:

```powershell
$existing = if (Test-Path $TargetFile) {
  [regex]::Replace((Get-Content -Raw -Path $TargetFile), '…', '')   # line 176
} else { '' }
$block = "`r`n$marker`r`n$($script:snippet)`r`n$endMarker`r`n"
Set-Content -Path $TargetFile -Value ($existing.TrimEnd() + $block) # line 180
```

`[regex]::Replace()` rejects a null input, so the assignment never completed and `$existing`
stayed null — which is the second error, on the next line.

Reproduced under pwsh before changing anything, three cases:

| target file | before |
|---|---|
| exists, empty | **throws**, file left at 0 bytes |
| exists, has content | fine |
| does not exist | fine |

So one of the six AI tools on that machine has an empty instruction file, and it is the only
one affected. The other five received the rule.

### Why it was quiet

Both errors are non-terminating. The script continued to the next tool and then printed a
fixed `[ OK ] Upgrade rules synced to detected AI tools`, which is true of five of the six.
The line does not depend on anything that happened, so it could not have said otherwise.

### What changes

`Add-OwnMindUpgradeRule` moves to `scripts/windows/lib/append-upgrade-rule.ps1` — the same
place `find-git-bash.ps1` already lives — so it can be exercised directly instead of only by
running the whole updater on a machine that happens to have the wrong file on it.

- a null read is treated as `''`, which is what every caller meant
- the function returns `written` or `skipped`, and throws on anything else
- `update.ps1` counts the results and prints the count; a tool that failed is named
- writes go through `WriteAllText` rather than `Set-Content -Encoding UTF8`, which adds a
  UTF-8 BOM on PowerShell 5.1 to files other vendors' tools read

`scripts/update.sh` does not share this crash — it reads through Node, and `readFileSync` on an
empty file returns `''`. It did share the unconditional summary line, which section 3 covers.

---

## 2. The 整體分析 page blamed a size limit that does not exist

v1.26.137 fixed the 14-day and 30-day reports failing, and recorded the cause as a hard
40 KiB ceiling on the LLM gateway, found by bisection. **That was wrong**, and it is worth
recording how, because the measurement looked careful: the probe bodies were built by
repeating one short phrase, which costs far fewer tokens per byte than a real report. The
boundary the bisection found was not a boundary in bytes.

### What was measured on 2026-08-11

| what | result |
|---|---|
| 40,214-byte probe body | 200 |
| route's real 14-day body, 35,301 bytes, during the failing window | **502**, four times |
| the same bytes replayed 20 minutes later, 3 sequential | 200, 200, 200 |
| the same bytes, 3 concurrent | 200, 200, 200 |
| the endpoint itself, 5 calls | 200 × 5 |

Server log during the failing window:

```
LLM upstream 502: All 3 provider attempts failed:
  groq/llama-3.3-70b-versatile: Client error '413 Payload Too Large' …
```

A body of 40,214 bytes went through while 35,301 was refused. Size is not what decides it —
the gateway's spare capacity at that moment is, and a larger payload is likelier to exceed
whatever is left. The 7-day report (31,929 bytes) kept working throughout for that reason
and no other, which is exactly what made this look like a size limit.

### What changes

`callLLMSwitch` retries. A gateway that is out of capacity now is usually not out of
capacity three seconds later, and a reader should pay for that in seconds rather than in a
missing report.

- retries 408, 429 and 5xx, a connection that fails outright, and a body that stalls after
  the headers have arrived
- does not retry the other 4xx, which the gateway will simply repeat (408 is a 4xx, and is
  the gateway asking for another go)
- two retries, 3 seconds apart, and a 60-second overall deadline that also clamps each
  attempt's timeout, so nobody waits 90 seconds for three stalls
- the thrown error says how many attempts were spent

The upstream reply is kept to 2,000 characters instead of 200. Diagnosing this needed the
request replayed by hand from the server, because the log was cut off mid-sentence exactly
where the second and third providers' reasons would have been. v1.26.137 listed widening it
as a known gap; this is it.

The condensing from v1.26.137 stays as it is, at the same 38,000-byte budget. It still buys
better odds, which is all it ever bought. What changes is that the code no longer claims it
buys a guarantee: the comments asserting a 40 KiB ceiling are replaced with what was
measured.

---

## 3. What the review rounds found

Two rounds. Most of what follows is in code this change added, and none of it was visible to
the tests as first written.

### The retry destroyed the error it was annotating

Appending `(after N attempts)` was done by assigning to `lastError.message`. A real aborted
fetch rejects with a `DOMException`, whose `message` is a getter-only accessor; this file is
a module, so assigning to it throws. Verified against the real function with a `fetchImpl`
that honours the signal and fakes nothing else:

```
THROWN: TypeError | Cannot set property message of  which has only a getter
```

Every timeout would have reached the log as that TypeError, with the 2,000-character
upstream excerpt — the whole point of the second half of this change — thrown away.

The test that covered this scenario passed, because it built the abort as
`new Error(); err.name = 'AbortError'`, and a plain Error has a writable `message`. Both
ends of the interface were fabricated, so the fakes only agreed with each other. It now uses
a `fetchImpl` that honours the signal, which is what a stalled gateway does.

The loop no longer mutates anything it caught: transport failures are re-thrown as errors of
ours, and the final message is a new `Error` with the original as its `cause`.

### Retrying was decided by a substring match on the model's own output

`isTransportError` tested the message for `network|socket|fetch failed|ECONN`, and the
message for a parse failure embeds the model's reply. A report that happened to mention a
network error was retried three times and then reported as a transport failure. Classifying
now happens where the failure occurs — the `fetchImpl` call is in its own try block —
so anything after a response has arrived is surfaced immediately.

### The deadline let a doomed attempt start

The deadline was checked only after a failure and before the sleep, so the sleep could carry
the clock past it and the next attempt would start with a millisecond of budget, burn a slot,
and replace a useful 502 with a timeout. It is checked before starting an attempt now.

### Reading BOM-less UTF-8 by code page

Writing without a BOM is right, but `Get-Content -Raw` on Windows PowerShell 5.1 decodes a
file with no BOM in the system ANSI code page — cp950 on the Traditional Chinese Windows this
was reported from. The write and the read together would have taken a user's own Chinese
notes, decoded them as Big5 on the next update, and written the damage back.

Both reads in this flow now use `[System.IO.File]::ReadAllText`, which is UTF-8 and still
honours a BOM left by an older version.

This turned up a live defect that predates the change: `$snippet` itself was read with
`Get-Content -Raw`, and `skills/ownmind-upgrade-agents-snippet.md` is UTF-8 with Chinese in
it and no BOM. Every Traditional Chinese Windows machine has been writing a mangled copy of
the upgrade rule into every AI tool it found.

### The same timeout, one door further in

The second round found the fix above had a twin it did not cover. `res.json()` sat outside
the try that classifies failures, so a gateway that returns 200 headers and then stalls
streaming the body — the same out-of-capacity shape, and a common one under load — produced:

```
DOMException: "This operation was aborted" | calls=1 | retried? false
```

No retry, and a log line with no attempt count, no URL and no mention of a timeout: exactly
the shape the first fix existed to remove. The body read is now inside the classification,
while `parseLLMJson` stays outside it — a body that arrives and does not parse arrives the
same way next time, and a body that never arrives does not.

### Three smaller ones from the same round

- The **inter-attempt sleep was not clamped** by the deadline, so the "60-second deadline"
  was really up to 63. It is clamped now, and the number in the docs is true.
- **`retries: NaN`** made `attempts` NaN, the loop never ran, and the throw at the end
  dereferenced an error nobody had assigned. `Number.isFinite` guards it.
- **An unparseable `apiBase`** was retried three times as a transport failure, spending six
  seconds of the reader's patience on a fixed answer. The URL is built once, before the loop.

### `update.sh` had the same unconditional summary

The null crash is Windows-only, but the line this release is named after was not:
`update.sh` also ended the step with a fixed `[ OK ] Upgrade rules synced to detected AI
tools`, and its strip step ended in `|| true`, so a Node that could not run left the previous
block in place while the append added a second one. A third, found in the second round: the
snippet was `cat`-ed inside a command group, and a group's status is its last command's — a
snippet that exists but cannot be read wrote an empty rule block between the markers and
returned success. All three are fixed, and the tests drive the block lifted out of the real
script rather than a copy of it.

## What this does not change

No behaviour visible on the page, other than 14-day and 30-day reports arriving instead of
failing when the gateway is busy. Report content, the condensing notes shown above a
summarised report, and the mechanical report are all untouched.

## What this does not fix

- `admin.js`, `broadcast.js` and `bug-reports.js` still parse row ids with `parseInt`, the
  milder form of the v1.26.136 defect. Still open.
- `redactPIIDeep` turns `Date` objects into `{}`, so `last_activity` and `last_reported_at`
  reach the model as empty objects. Pre-existing, and not touched here.
