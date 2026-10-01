# Research: how AI-coding usage data gets turned into insight/billing elsewhere

Overnight research pass (2026-08-03/04), five parallel research agents, feeding
directly into the feature additions in this same session. Sources are linked
inline in each section.

## 1. Competitor AI-coding-assistant dashboards

- **GitHub Copilot** (Metrics API/Business dashboard): acceptance rate +
  suggestions shown/accepted, broken out by language and editor. Adoption rate
  = active seats ÷ licensed seats — a seat-utilization metric. No cost/ROI
  framing at all.
- **Cursor + minware**: minware is the standout — regresses delivery metrics
  against token spend ("extra PRs shipped per dollar of AI spend"), ties spend
  to epics/cost centers for capitalization reporting, links session → commit →
  ticket across tools. The clearest "ROI dashboard for AI coding" concept found.
- **Sourcegraph Cody**: frames value as **time saved**, with **admin-editable
  time-saved-per-event constants** so admins tune the ROI assumption to their
  own environment rather than trust a vendor default. Weighted Completion
  Acceptance Rate (wCAR) weights by characters accepted, not just accept/reject
  counts.
- **Claude Code's own analytics dashboard**: matches session diffs against
  merged PRs (21-day window, 20%-rewrite exclusion) for "% of merged PRs
  containing Claude-assisted code." Requires git/PR data we don't ingest.
- **ccusage** (closest OSS sibling): 5-hour billing-block report with live
  burn-rate monitoring; cache-creation vs. cache-read as distinct cost lines;
  per-project grouping and custom pricing overrides.
- **Amazon Q Developer**: breaks accepted-lines down by *which agent
  capability* was used (`/dev`, `/doc`, `/test`) — a segmentation angle
  applicable to our tool-call taxonomy.

Sources: [copilot-metrics-dashboard](https://github.com/microsoft/copilot-metrics-dashboard), [minware Cursor guide](https://www.minware.com/blog/cursor-dashboard-complete-guide-tracking-team-usage-cost-roi), [Sourcegraph admin analytics](https://sourcegraph.com/blog/admin-analytics), [Claude Code analytics docs](https://code.claude.com/docs/en/analytics), [ccusage](https://github.com/ryoppippi/ccusage), [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), [AWS Q Developer dashboard metrics](https://docs.aws.amazon.com/en_us/amazonq/latest/qdeveloper-ug/dashboard-metrics-descriptions.html).

## 2. Engineering-intelligence platforms (DX, Swarmia, LinearB, Jellyfish, SPACE/DORA)

- **Investment Profile / time-allocation charts** (LinearB, Jellyfish, Pluralsight
  Flow, Swarmia, DX "Innovation Ratio") are the single most common
  leadership visual: work bucketed into New Work / Enhancement /
  Maintenance / Rework, as a stacked-bar or trend-over-time %, often against
  an industry benchmark line (LinearB cites ~55/20/15/10). True work-type
  classification needs git/PR data tied to issue-tracker labels, which we
  don't ingest — but a **derivable proxy** exists: Claude Code sessions map
  1:1 to a project directory, so a stacked-area **"investment by
  client/repo over time"** chart is buildable today from data we already
  have. **Implemented tonight** (frontend-only — reuses existing `/api/data`
  records).
- **Cost-per-commit / cost-per-PR** (Faros AI, built explicitly for
  AI-coding-tool ROI) — derivable if we detect `git commit` inside the
  Bash tool-call commands already logged in every session transcript.
  **Implemented tonight** (new `CommitCount` column, populated during sync
  by pattern-matching Bash commands).
- **Cycle-time breakdown** (coding → pickup → review → deploy) needs PR/git
  review timestamps we don't have. A derivable analog — think-time vs.
  tool-execution-time vs. idle gaps within a session — is a reasonable
  future addition, not built tonight.
- **DXI/SPACE satisfaction scores, DORA's deploy-frequency/MTTR/change-failure
  metrics** all require survey data or CI/CD+incident-tracker integration we
  don't have. Not usable as-is; noted as a real gap rather than faked with a
  proxy.
- **Executive $-denominated reporting** (DX "GenAI Impact Report", Jellyfish
  DevFinOps) — the presentation pattern (translate cost+time into $/client)
  is exactly what our Invoicing tab already does; their underlying
  "hours-saved" figures are self-reported/estimated too, same limitation we
  inherit and already handle by labeling it an assumption (see §4).

Sources: LinearB Investment Profile, Jellyfish Work Allocation Model, Pluralsight Flow Investment Profile, Swarmia Investment Distribution, DX Core 4 / Innovation Ratio, Faros AI cost-per-commit/PR, dora.dev.

## 3. Consulting time-billing & invoicing conventions

- **Rounding**: Harvest supports rounding to nearest/round-up increments of 6,
  15, or 30 minutes **at export/invoice time only** — raw tracked time stays
  unrounded. 15 minutes is the de facto dev-consulting standard (vs. 6 min in
  legal). Round to a finer grain before applying the billing unit to avoid
  systematic overcharging.
- **Line-item grouping**: detailed mode (one line per session) vs. summarized
  (by task/person/project/day) — collapsing a day's sessions into one
  descriptive line for the client-facing export, while keeping the detailed
  view for internal audit.
- **Utilization**: billable ÷ total available hours, 65–80% is the typical
  professional-services target (20–35% non-billable overhead is *normal*, not
  a problem to eliminate).
- **AI-billing transparency**: no dev-specific consensus; legal-ethics opinions
  (ABA Op. 512 and state bars) converge on disclosing AI use in the engagement
  terms, not discounting fees just because AI sped things up (bill actual time,
  not a pre-AI benchmark), and keeping tool-cost pass-through as a distinct
  line from professional fees. Practical takeaway: **keep AI-usage provenance
  in the internal/audit layer, not stamped on every client invoice line**,
  unless the contract specifically calls for it.

Sources: [Harvest rounding](https://www.getharvest.com/blog/2010/01/rounding-up-incremental-billing), [Harvest 15-min billing](https://www.getharvest.com/calculators/how-to-bill-in-15-minute-increments), [Minnesota Lawyer — AI billing ethics](https://minnlawyer.com/2024/07/29/ethical-considerations-in-billing-for-ai-assisted-work/), [My Shingle — passing AI costs to clients](https://www.myshingle.com/2026/07/the-one-about-passing-ai-costs-through-to-clients/).

## 4. AI-coding productivity measurement: pitfalls and defensible metrics

- **METR RCT (2025)**: 16 experienced OSS developers were measured **19%
  slower** with AI tools on real issues in mature repos they knew well, despite
  forecasting a 24% speedup and self-reporting a 20% speedup afterward — a
  genuine perception/reality gap. Caveats: only 1 of 16 had a week+ of prior
  tool experience (may be a learning-curve effect, not a ceiling); task context
  was narrow (large, unfamiliar-to-tooling brownfield OSS); METR itself calls
  the result "historical" given how fast tools moved since. A counter-study
  (Faros AI) found high-adoption teams handled 9% more tasks and shipped 47%
  more PRs/day — throughput effects look different from single-task speed.
- **Metrics to avoid**: lines of code (rewards verbosity, punishes valuable
  deletion/refactoring), suggestion acceptance rate (shows it was taken, not
  that it survived review), raw activity counts (trivially inflated —
  "velocity theater"), and self-reported time-saved (METR's own headline
  finding: self-perception ran ~40 points off measured reality).
- **Defensible alternatives**:
  1. **Rework rate** — DORA's newer 5th metric (% of delivery effort spent
     re-fixing "done" work) — directly derivable from our own `FileTouches`
     table: flag files re-touched repeatedly in a short window. **Implemented
     tonight** (see below).
  2. **Investigative vs. code-changing ratio** — tool-call mix (Read/Grep/Bash
     vs. Edit/Write) as a friction/overhead proxy instead of raw tool-call
     volume. **Implemented tonight.**
  3. Avoid before/after speed claims entirely; any "time saved" figure should
     be presented as an **adjustable assumption**, not a measurement (see
     Sourcegraph pattern above). **Implemented tonight.**
- **Security caveat**: 45–62% of AI-generated code samples in 2025 studies
  (Veracode, Cloud Security Alliance) carried OWASP-Top-10-class
  vulnerabilities. Worth a footnote so high tool-usage volume is never
  implied to equal quality.

Sources: [METR study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) / [arXiv:2507.09089](https://arxiv.org/abs/2507.09089), [Faros AI — lab vs. reality](https://www.faros.ai/blog/lab-vs-reality-ai-productivity-study-findings), [Faros AI — LOC vanity metric](https://www.faros.ai/blog/lines-of-code-metric-ai-vanity-outcome), [LeadDev — 8 metrics AI broke](https://leaddev.com/ai/the-8-software-engineering-metrics-ai-broke), [DORA 2025 takeaways](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025), [OX Security — vibe coding](https://www.ox.security/blog/vibe-coding-security/).

## 5. Cost anomaly detection & forecasting (simple, no ML required)

- **Anomaly flag**: day-of-week z-score baseline + a dollar floor (to avoid
  noise on quiet accounts), mirroring AWS Cost Anomaly Detection's threshold
  design and Datadog's "relative AND absolute" gate:
  ```
  baseline_mean/stddev = trailing 4–8 weeks of daily cost, same weekday, excluding today
  z = (today_cost - baseline_mean) / baseline_stddev
  flag = z > 2.0 AND (today_cost - baseline_mean) > min_dollar_threshold
  ```
  **Implemented tonight** (see below).
- **Month-to-date forecast**: Azure/AWS both use straight run-rate
  extrapolation as the base case:
  ```
  forecast_month_total = MTD_cost_so_far / days_elapsed * days_in_month
  ```
  with day-of-week weighting as the natural upgrade over a flat multiplier.
  **Implemented tonight.**

Sources: [AWS Cost Anomaly Detection thresholds](https://aws.amazon.com/about-aws/whats-new/2022/12/aws-cost-anomaly-detection-percentage-based-thresholds), [Datadog Cloud Cost Monitor](https://docs.datadoghq.com/monitors/types/cloud_cost/), [RisingWave — anomaly detection stats](https://risingwave.com/blog/effective-anomaly-detection-in-time-series-using-basic-statistics/), [Azure Cost Management — run rate](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/cost-analysis-common-uses).

## 6. Freelance/agency billing tools: any AI-specific billing features?

- **No billing tool has shipped AI-specific billing features.** Checked Bonsai,
  HoneyBook, Dubsado, Ignition/Practice Ignition, AND.co — none has an
  "AI work" line item, AI-effort category, or AI-usage rate card. Ignition's
  2026 "Price Insights" uses AI to *benchmark fees against industry data*
  (AI helping you price, not a mechanism for billing AI-assisted deliverables
  differently); Dubsado 3.0 tightened hours-to-invoice flow generally; none
  of it is AI-specific. This space is unsolved at the tooling layer — a
  genuine positioning gap, not just something we missed.
- **The hourly-billing "efficiency penalty" is the live debate.** Hourly
  billing structurally penalizes AI-driven speed: if AI cuts a task from 10
  hours to 4, the invoice drops 60% for identical delivered value — sharpest
  framing comes from the legal sector (a task that used to bill $5,000 now
  bills $500 once AI makes you 10x faster at it). Value-based/fixed pricing
  is the commonly-cited fix (sources cite 40%–2-3x higher effective realized
  rates), because efficiency gains become margin instead of lost revenue —
  the only model where getting faster with AI increases pay. Counter-argument
  for keeping hourly: simplicity and client trust (hours are easy to audit;
  value pricing needs more scoping/negotiation confidence).
- **Implication for this dashboard**: it's built entirely around hourly
  billing (active/idle rate × hours). That's a reasonable default (matches
  what Harvest/Toggl/every competitor does), but the "efficiency penalty"
  dynamic is real and worth surfacing, not silently absorbing. See the
  cost-per-commit / hours-per-commit trend note below.

Sources: Ignition Price Insights (Accounting Today 2026 Top New Product coverage), Dubsado 3.0 release notes, general 2025-2026 freelance-pricing and legal-billing commentary on hourly vs. value-based pricing under AI-driven efficiency gains.

## What got built from this (2026-08-03/04 overnight session)

See git log for the commit(s) following this file's creation. Summary:
rework-rate / hot-file-churn insight, tool-use taxonomy (code-changing vs.
investigative vs. execution vs. orchestration vs. external), day-of-week cost
anomaly flag, month-to-date spend forecast, an adjustable "estimated manual-work
multiplier" per client (clearly labeled as an assumption, not a measurement,
per the Sourcegraph/METR findings above), invoice rounding/minimum-increment
config, a cache-cost breakdown (input/output/cache-write/cache-read as
separate components), an "investment by client over time" stacked chart, a
utilization metric (billable vs. non-billable active hours), a rough session
cycle-time split (waiting on tool result vs. waiting on model, within
already-active time), cost-per-commit (detected via Bash command
pattern-matching), and CSV export for the invoice and the full per-repo
breakdown table.

**Update**: real git-log commit correlation got built after all (see below) —
narrower than Claude Code's own PR-diff attribution, but a genuine upgrade
from the Bash-text heuristic for any repo still on disk as a git repository.

**Deliberately not built**: PR-diff attribution / "% of merged PRs containing
Claude-assisted code" (Claude Code's own dashboard and minware both do this,
but it requires correlating session diffs against actual PR/merge data,
which is a materially bigger integration than reading `git log`) , 5-hour live
billing-block monitoring (ccusage's live-monitor use case doesn't fit a
historical/DB-backed tool well — this stays a `ccusage`-shaped niche), and any
"time saved" framing presented as a hard number rather than an adjustable,
clearly-labeled assumption (the METR findings make that an explicit
non-goal).

## Research update - 2026-08-23

Weekly check against this file's last entry (2026-08-03/04). Found genuine
movement in three of the five areas; freelance-billing tools (still no
AI-specific billing feature anywhere — Bonsai, HoneyBook, Dubsado all
confirmed unchanged) and simple anomaly/forecasting techniques (nothing
new beyond what §5 already covers) turned up no update worth recording.

- **Competitor dashboards**: GitHub Copilot's admin surface shipped an
  **Impact Dashboard** (22 Jul 2026) that groups engaged users into
  AI-adoption-phase cohorts — Phase 1 (code-first), Phase 2 (agent-first),
  Phase 3 (multi-agent) — each card showing merge velocity and
  lines-of-code-per-user-per-day, then added a **"Potential return on
  investment" section** (7 Aug 2026) that connects Copilot spend directly to
  PR output. That's the minware-style spend→output ROI framing (already
  noted in §1) now shipped by the platform vendor itself rather than a
  third party — the adoption-phase-cohort segmentation is a genuinely new
  angle (not just "active vs. licensed") worth remembering if we ever build
  a similar client/repo maturity view. Nothing else materially new in
  ccusage, Cursor/minware, or Claude Code's own analytics surface this week
  — Cursor's August changes were cloud-agent infrastructure, not
  dashboard/billing features, and Claude Code's new "Reflect" view is an
  individual habit-tracker, not a consultancy-billing-relevant surface.
- **Engineering-intelligence platforms**: LinearB's 2026 Software
  Engineering Benchmarks Report (8.1M PRs, 4,800 teams) found technical
  debt up 30–41% following AI adoption, only 32.7% of AI-authored PRs
  merging without modification (vs. 84.4% for human-authored PRs), and
  review time up 91% on high-AI-adoption teams — human review, not coding,
  is the new bottleneck. Directly relevant to this dashboard's rework-rate
  proxy (§4): independent confirmation that "AI wrote it fast" and "it
  shipped clean" are different claims, and that AI's time cost tends to
  resurface downstream as review/rework rather than disappearing. A
  separate large-scale study, "Debt Behind the AI Boom" (arXiv:2603.28592,
  302.6k verified AI-authored commits across 6,299 repos, 5 assistants
  including Claude and Copilot, before/after static analysis per commit),
  found a per-tool rate of AI-authored commits introducing at least one
  code-smell/correctness/security issue ranging roughly from the high
  teens to high 20s in percent depending on the assistant, with 22.7% of
  those issues still unresolved at the latest repository revision — same
  shape of finding as the Veracode/CSA caveat already in §4, now with
  commit-level attribution instead of a sampled snapshot.
- **AI-coding productivity research**: METR's early-2026 follow-up
  **reverses the sign** of the headline -19%-slower finding already cited
  in §4 — for the subset of original developers re-tested, the estimated
  effect flipped to a **+18% speedup** (CI -38% to +9%, still wide enough
  to cross zero); newly recruited developers showed -4% (CI -15% to +9%).
  METR itself frames this as inconclusive rather than a win: the intended
  larger follow-up experiment had to be abandoned because so many
  developers now refuse to work without AI assistance that a clean control
  group is no longer recruitable. The actionable takeaway isn't "AI is now
  proven faster" — it's that self-reported and even RCT-measured speed
  effects are still an unsettled, moving target, which reinforces (doesn't
  loosen) the existing rule in this codebase against presenting "time
  saved" as a hard number. Separately, a Microsoft-internal field study
  (arXiv:2607.01418, tens of thousands of engineers, first-half-2026
  Claude Code + Copilot CLI rollout) used direct developer telemetry
  rather than surveys and found adopters merged roughly 24% more PRs than
  a counterfactual baseline predicted — a throughput result in the same
  direction as the Faros AI counter-study already cited in §4, now from a
  much larger and more directly instrumented sample.

Sources: [Copilot impact dashboard](https://github.blog/changelog/2026-07-22-new-copilot-usage-metrics-impact-dashboard/), [Copilot impact dashboard ROI section](https://github.blog/changelog/2026-08-07-copilot-impact-dashboard-adds-a-return-on-investment-section/), [LinearB 2026 Benchmarks — 8M PRs](https://linearb.io/blog/8-million-prs-engineering-productivity), [LinearB — AI PRs merge at half the rate of human code](https://linearb.io/dev-interrupted/podcast/linearb-2026-benchmarks-ai-pr-merge-rate), [Debt Behind the AI Boom (arXiv:2603.28592)](https://arxiv.org/abs/2603.28592), [METR — changing our developer productivity experiment design (2026 update)](https://metr.org/blog/2026-02-24-uplift-update/), [Rob Bowley — summary of METR's 2026 update](https://blog.robbowley.net/2026/04/04/metrs-developer-productivity-research-2026-update/), [Microsoft Claude Code / Copilot CLI rollout study (arXiv:2607.01418)](https://arxiv.org/abs/2607.01418).

## Research update - 2026-09-20

Weekly check against this file's last entry (2026-09-13, 7 days prior). Searched
all six areas: competitor dashboards (GitHub Copilot's admin surface, Cursor,
minware, Sourcegraph Cody, Amazon Q Developer, Claude Code's own release
notes, ccusage), engineering-intelligence platforms (LinearB, Jellyfish, DX,
Swarmia), AI-coding productivity research, freelance billing tools (Bonsai,
Dubsado, Ignition/Practice Ignition), and anomaly/forecasting techniques.

- **Competitor dashboards**: GitHub's Copilot impact dashboard shipped a
  **feature-engagement breakdown** (17 Sep 2026, 4 days before this check) —
  for each 28-day reporting window it now shows how many active users
  engaged with each individual Copilot surface (code completion, agent
  edit, passive/active code review, cloud agent, CLI, app) on at least two
  days, so admins can see which specific features are sticking vs. which
  need enablement push, not just aggregate seat activation. The
  enterprise/org report APIs got the same breakdown plus a rolling-28-day
  population fix to the adoption-phase reporting already noted in the
  2026-08-23 entry. This is a genuinely new segmentation axis (per-feature
  engagement, not just per-user) worth remembering alongside that entry's
  adoption-phase-cohort note if a future per-tool-capability breakdown gets
  built here (this dashboard already has a comparable angle via
  `ToolUsage`/tool-call taxonomy). Nothing else new this week: Cursor,
  minware, Sourcegraph Cody, Amazon Q Developer, Claude Code's own release
  notes (auto-mode classifier billing change, AGENTS.md support — CLI
  ergonomics, not analytics/billing), and ccusage all turned up only
  comparison/explainer content or non-dashboard changes.
- **Engineering-intelligence platforms**: LinearB's 8.1M-PR 2026 Benchmarks
  report (already cited 2026-08-23) is still circulating with additional
  cut stats — "AI PRs wait 4.6–5.25x longer for review pickup," "1.7x more
  issues per PR" — but these are the same underlying dataset/report already
  recorded here, not a new report or a new finding; not re-cited as new.
  No new report from Jellyfish, DX, or Swarmia this week.
- **AI-coding productivity research**: no new study. The widely-recirculated
  "93% AI adoption, only ~10% productivity gain" framing traces to DX
  Research's ~135,000-developer study, published 28 Apr 2026 — predates
  this file's tracking window and is a rehash of ground already covered by
  the Cui et al. (Microsoft/Accenture, junior-vs-senior split) and
  Microsoft Claude Code/Copilot CLI rollout papers already cited in the
  2026-09-06 and 2026-08-23 entries.
- **Freelance billing tools**: Bonsai, Dubsado, Ignition/Practice Ignition
  confirmed still shipped no AI-specific billing feature.
- **Anomaly/forecasting techniques**: AWS shipped a **Detected Anomalies
  widget** for Billing and Cost Management Dashboards (15 Sep 2026) —
  surfaces anomaly count and total $ impact relative to month-to-date
  spend, filterable by severity/service/account, with per-anomaly root
  cause and duration. It's a presentation layer on top of the same AWS
  Cost Anomaly Detection service already cited in §5, not a new detection
  technique, so not implemented — but the "anomaly count + $ impact vs.
  MTD spend, with per-anomaly duration" framing is a reasonable future
  presentation upgrade for this dashboard's existing z-score flag if that
  UI ever gets its own dedicated view (currently just an inline flag).

Sources: [Copilot impact dashboard — feature engagement](https://github.blog/changelog/2026-09-17-copilot-impact-dashboard-now-shows-feature-engagement/), [LinearB 2026 Benchmarks — AI in software development](https://linearb.io/library/ai-in-software-development), [DX — AI productivity gains: more modest than expected](https://getdx.com/blog/ai-productivity-gains-more-modest-than-expected/), [AWS — Detected Anomalies widget for BCM Dashboards](https://aws.amazon.com/about-aws/whats-new/2026/09/monitor-detected-anomalies-using-dashboards/).

## Research update - 2026-09-13

Weekly check against this file's last entry (2026-09-06, 7 days prior). Searched
all six areas: competitor dashboards (GitHub Copilot's admin/enterprise
surface, Cursor, minware, Sourcegraph Cody, Amazon Q Developer, Claude Code's
own analytics surface, ccusage), engineering-intelligence platforms (LinearB,
Jellyfish, DX, Swarmia, DORA), AI-coding productivity research, freelance
billing tools (Bonsai, Dubsado, Ignition/Practice Ignition), and
anomaly/forecasting techniques. Nothing found post-dates and materially
updates what's already recorded above. Two items surfaced that looked
promising on first read but turned out to be older than they appeared: the
NBER working paper ["Writing Code vs. Shipping
Code"](https://www.nber.org/papers/w35275) (Demirer/Musolff/Yang; 100k+
GitHub developers across three tool generations; +180% code generation vs.
+36% production releases — a "weak-link"/bottleneck-moves-downstream finding
distinct from the Cui et al. paper already noted in the 2026-09-06 entry) is
dated May 2026, and Faros AI's ["Acceleration
Whiplash"](https://www.faros.ai/research/ai-acceleration-whiplash) report
(22,000 developers, median code review time +441.5% vs. +33.7% task
throughput) is dated April 2026 — both predate this file's tracking window
and would already have been in scope for earlier refreshes, so neither is
recorded as a new finding here. Cursor shipped "Projects" (10 Sep 2026,
longer-horizon multi-agent delegation) but this is an agent-workflow feature,
not a dashboard/billing/analytics surface, so out of scope. GitHub Copilot's
Code generation Metrics Dashboard reaching public preview is dated December
2025, older than this file itself. Freelance billing tools (Bonsai, Dubsado)
remain confirmed to have shipped no AI-specific billing feature. No
commit-worthy update found this cycle beyond this note.

## Research update - 2026-09-01

Monthly check against this file's last entry (2026-08-23, only 9 days prior —
the weekly-refresh cadence had already absorbed the month's genuine news).
Searched all six areas — competitor dashboards (GitHub Copilot, Cursor/minware,
Sourcegraph Cody, Claude Code's own analytics surface, ccusage, Amazon Q),
engineering-intelligence platforms (LinearB, Jellyfish, DX, Swarmia, SPACE/DORA),
AI-coding productivity research (including a fresh check on METR, which last
posted its self-reported-impact survey in May 2026 and a developer-productivity
experiment-design rework in February, both already cited above), freelance
billing tools (Bonsai, Dubsado, Ignition — still confirmed to have shipped no
AI-specific billing feature), and anomaly/forecasting techniques — and found
nothing that post-dates and materially updates what's already recorded above.
Notable items surfaced were all older than 2026-08-23 and already reflected
here: Claude Code's Artifacts-as-live-dashboards feature (shipped 18 Jun 2026,
predates even this file's creation), and the Veracode/Cloud Security Alliance
AI-code-vulnerability figures (April 2026, already captured by the §4 caveat).
No commit-worthy update found this cycle beyond this note.

## Research update - 2026-09-06

Weekly check against this file's last entry (2026-09-01, 5 days prior).
Searched all six areas: competitor dashboards (GitHub Copilot's admin
surface, Cursor, minware, Claude Code's own release notes, ccusage),
engineering-intelligence platforms (LinearB, Jellyfish, DX, Swarmia),
AI-coding productivity research, freelance billing tools (Bonsai, Dubsado,
Ignition/Practice Ignition), and anomaly/forecasting techniques. Everything
surfaced either predates 2026-09-01 and is already reflected above (GitHub
Copilot's Code Generation Metrics Dashboard, shipped Dec 2025/GA Feb 2026;
Ignition's Price Insights and AutoPricing, both already noted in §6; METR's
May 2026 self-reported-impact survey and February experiment-design
rework, both already cited) or is out of scope for this dashboard's
billing/analytics/productivity-measurement focus (Claude Code CLI's
September point releases were CLI ergonomics — output-size limits, org
policy diagnostics — not analytics/billing features; Cursor's September 2
update was self-hosted-machine/cloud-agent infrastructure, not a
dashboard or billing feature). One candidate worth flagging as *not* newly
relevant: a Management Science-published field-experiment paper ("The
Effects of Generative AI on High-Skilled Work," Cui/Demirer/Jaffe/
Musolff/Peng/Salz, across Microsoft/Accenture/a Fortune 100 manufacturer,
~4,867 developers) reporting an average 26% productivity gain concentrated
in junior/less-tenured developers with senior developers showing little
or no measurable speedup — directly relevant to §4's productivity-pitfalls
discussion, but the underlying working paper has circulated on SSRN since
2024/2025, so this is a journal-publication milestone rather than a new
finding; noted here in case a future refresh finds it got a fresh, truly
new follow-up. No commit-worthy update found this cycle beyond this note.

## Research update - 2026-09-27

Weekly check against this file's last entry (2026-09-20, 7 days prior). Searched
all five areas: competitor dashboards (GitHub Copilot's admin surface, Cursor,
minware, Sourcegraph Cody, Amazon Q Developer, Claude Code's own release
notes, ccusage), engineering-intelligence platforms (LinearB, Jellyfish, DX,
Swarmia, DORA), AI-coding productivity research, freelance billing tools
(Bonsai, Dubsado, Ignition/Practice Ignition), and simple anomaly/forecasting
techniques. Nothing found post-dates and materially updates what's already
recorded above.

- **Competitor dashboards**: Cursor shipped [Rollouts and Security
  Review](https://cursor.com/blog/rollouts-and-security-reviewer) bots
  (23 Sep 2026, enabled from its Teams/Enterprise dashboard) — per-environment
  deploy-health monitoring and per-PR exploit scanning. Out of scope here the
  same way prior entries excluded Cursor's cloud-agent infrastructure
  changes: neither is a cost/usage/billing analytics surface. GitHub
  Copilot's impact dashboard had no update this week beyond the 17 Sep
  feature-engagement breakdown already recorded in the last entry. [Amazon Q
  Developer is being wound down](https://aws.amazon.com/blogs/devops/amazon-q-developer-end-of-support-announcement/)
  in favor of AWS's new "Kiro" IDE, but that announcement dates to 30 Apr
  2026 — well outside this file's tracking window, not a new development.
  Sourcegraph Cody, minware, and ccusage turned up no changes this week.
- **Engineering-intelligence platforms**: no new report from LinearB,
  Jellyfish, DX, or Swarmia this week. DORA's [ROI of AI-assisted Software
  Development report](https://dora.dev/ai/roi/report/) (a J-curve
  value-realization model, with code review framed as the critical
  value-capture stage) looked promising on first read but is dated
  2026.01/early-to-mid 2026 — predates this file's tracking window, so not
  recorded as new.
- **AI-coding productivity research**: a [126-study systematic
  review](https://reinvently.co.uk/blog/ai-coding-productivity-evidence/)
  (coding-stage gains ~20-30%, release-output gains only 10-30%,
  "agent-native" delivery cases reporting a 4.5x median/18x task-specific
  upside) was updated 17 Sep 2026, but was originally published 28 Jul 2026
  and is a synthesis of studies already reflected in this file's earlier
  entries (Cui et al., Faros AI, the Microsoft Claude Code/Copilot CLI
  rollout paper) rather than new primary evidence — not recorded as new.
- **Freelance billing tools**: Bonsai, Dubsado, Ignition/Practice Ignition
  confirmed still shipped no AI-specific billing feature (Bonsai was
  acquired by Zoom in Dec 2025; no AI-billing feature has followed from
  that).
- **Anomaly/forecasting techniques**: no new simple, SQL-dashboard-suitable
  technique found beyond what §5 already covers.

No commit-worthy update found this cycle beyond this note.

## Research update - 2026-10-01

Monthly check against this file's last entry (2026-09-27, 4 days prior) — took a
broader/deeper pass than the weekly cadence, searching back past the prior
entry for month-over-month trend pieces and quarterly/benchmark reports in
addition to individual news items, across all six areas: competitor
dashboards (GitHub Copilot, Cursor, minware, Sourcegraph Cody, Claude Code's
own analytics, ccusage), engineering-intelligence platforms (LinearB,
Jellyfish, DX, Swarmia, DORA), AI-coding productivity research (including a
fresh McKinsey check), freelance billing tools (Bonsai, Dubsado,
Ignition/Practice Ignition), and anomaly/forecasting techniques. Nothing
found both post-dates this file's tracking window and materially updates
what's already recorded above; several items looked promising on first pass
but turned out to be older or unsubstantiated on closer check:

- **Competitor dashboards**: Sourcegraph Analytics' User Cohorts Explorer
  (per-user credit consumption + custom saved cohorts) looked like a new
  Cody-adjacent feature, but it shipped 9 Jul 2026 — well before this file's
  own creation, not a new development. Cursor's 23 Sep 2026 token-efficiency
  work (46.9% token reduction on MCP-calling agent sessions) and Rollouts/
  Security Review bots were already recorded in the 2026-09-27 entry. Claude
  Code's own analytics dashboard and ccusage turned up only incremental
  version bumps, no new dashboard/billing-relevant feature.
- **Engineering-intelligence platforms**: no new report from LinearB,
  Jellyfish, DX, or Swarmia this cycle beyond what's already cited.
- **AI-coding productivity research**: a figure circulating across several
  SEO/content-farm blogs ("McKinsey, 4,500 developers across 150
  enterprises, AI cuts routine-task time 46% but <10% on high-complexity
  work") does not trace to any actual McKinsey publication — a direct check
  of mckinsey.com's own 2026 output (the April 2026 "AI revolution in
  software development" report, ~300 public companies, 16–30% productivity
  gains in the top quintile; the September 2026 "Technology Trends Outlook
  2026," which repeats the NBER-style +180%-coding-activity-vs-+30%-shipped
  finding already cited in the 2026-09-13 entry and adds that 46% of
  developers worldwide distrust AI-tool output accuracy vs. 33% who trust
  it; and the August 2026 "State of AI" survey) shows no 4,500-developer/46%
  study. Flagging this here so a future refresh doesn't re-discover and cite
  it as real without the same check — it appears to be fabricated/
  misattributed content, not a genuine new finding.
- **Freelance billing tools**: Bonsai (now under Zoom, per the 2026-09-27
  entry), Dubsado, and Ignition/Practice Ignition confirmed still shipped no
  AI-specific *billing* feature. Ignition does have an MCP server letting an
  AI assistant (Claude, ChatGPT) interact with a firm's Ignition account
  directly, live since ~20 Aug 2026 — but that's AI-assistant tooling access,
  not a billing-feature change (no AI-work line item, no AI-usage rate card),
  and it predates this file's tracking window regardless.
- **Anomaly/forecasting techniques**: nothing new beyond what §5 already
  covers — GCP's ML-based cost anomaly detection (the one unfamiliar item
  that surfaced) dates to its original Google Cloud Next '24 launch, not a
  2026 development.

Sources: [Sourcegraph — User cohort explorer and new date range options](https://sourcegraph.com/changelog/user-credits-cohort-analytics), [McKinsey — The AI revolution in software development (Apr 2026)](https://www.mckinsey.com/~/media/mckinsey/business%20functions/tech%20and%20ai/our%20insights/the%20ai%20revolution%20in%20software%20development/the-ai-revolution-in-software-development_final.pdf), [McKinsey — Technology Trends Outlook 2026 (Sep 2026)](https://www.mckinsey.com/~/media/mckinsey/business%20functions/mckinsey%20digital/our%20insights/the%20top%20trends%20in%20tech%202026/mckinsey%20technology%20trends%20outlook%202026.pdf), [McKinsey — The state of AI in 2026: On the road to ROI (Aug 2026)](https://www.mckinsey.com/~/media/mckinsey/business%20functions/quantumblack/our%20insights/the%20state%20of%20ai/the-state-of-ai-in-2026-on-the-road-to-roi.pdf), [Ignition — Using the Ignition MCP with your AI assistant](https://support.ignitionapp.com/en/articles/15516480-using-the-ignition-mcp-with-your-ai-assistant), [Google Cloud — Introducing Cost Anomaly Detection](https://cloud.google.com/blog/topics/cost-management/introducing-cost-anomaly-detection/).
