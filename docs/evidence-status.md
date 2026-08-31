# Current evidence status

This table is intentionally explicit and contains no dummy URL or model value.
Replace a status only after the referenced artifact exists and has been checked
signed out. Configuration, source code, and a planned capture are not execution
evidence.

| Evidence item | Current status | Claim rule |
| --- | --- | --- |
| Local deterministic tests and demo | **Evidenced:** 11 source test files and 78 tests pass with FFmpeg; the demo passes | Claim local reproducibility, not a Google model call |
| Public repository URL | **Evidenced:** [public Apache-2.0 repository](https://github.com/mlsniperpro/sigmora-creator-duty), checked signed out | Keep the final commit and CI status visible |
| Public Cloud Run URL | **Evidenced:** [live panel](https://creator-duty-ra3flcxmjq-uc.a.run.app), full hero campaign `cmp_5dc5f550c5146bebdbc2` | Health, panel, final image, and hero path verified |
| Authenticated Pub/Sub push | **Evidenced:** exact audience/identity plus start, replay, and end message IDs | Matching intake and campaign trace retained |
| Firestore cloud campaign/checkpoints | **Evidenced:** campaign, both claims, stream index, and four matching provider records | Same campaign/trace; see [cloud evidence](cloud-evidence.md) |
| Real `gemini-3.7-flash` invocation | **Evidenced:** three Vertex calls with requested/resolved model, response IDs, SDK, timestamps, and tokens | See [cloud evidence](cloud-evidence.md) |
| Scoped Sigmora media call | **Not yet evidenced—do not claim** | Require narrow provider receipt and immutable artifact; deterministic media remains the base path |
| External social-network publication | **Not yet evidenced—do not claim** | Sandbox receipts must remain labeled sandbox |
| Veo artifact | **Not yet evidenced—do not claim** | Require completed operation and model/artifact evidence |
| Lyria artifact | **Not yet evidenced—do not claim** | Require completed operation and model/audio evidence |
| Gemma critic | **Not yet evidenced—do not claim** | Require exact supported model invocation and typed result |
| Public submission video | **Evidenced:** [public YouTube demo](https://www.youtube.com/watch?v=qMmDiSgRm8Q), 91.4 seconds | Anonymous playback verified; English Gemini narration and captions; under four minutes |
| Public build article, podcast, or film | **Not yet evidenced—do not claim** | Require public access and the competition disclosure sentence |
| Public social bonus post | **Not yet evidenced—do not claim** | Require public URL and exact `#AllThingsAgenticHackathon` hashtag |
| Devpost submission URL | **Not yet evidenced—do not claim** | Require signed-out access and final frozen links |
| Measured outcome values | **Evidenced:** three final-image runs; median completion 30.467s and median recovery 0.775s | Demo measurements only; see [cloud evidence](cloud-evidence.md) |

When an item becomes evidenced, record the stable public URL where appropriate
and a private evidence-ledger reference. Never put demo keys, access tokens,
private bucket URLs, raw authorization headers, or customer data in this file.
