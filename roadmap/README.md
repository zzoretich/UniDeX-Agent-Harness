# How the roadmap works

[roadmap.md](roadmap.md) is the UniDeX roadmap: new features, functions and improvements, from first idea to
release. It has two readers.

- **People** read it as a page: https://zzoretich.github.io/UniDeX-Agent-Harness/. The page is built from roadmap.md
  every time the file changes on `main`, so the two always match.
- **Agents** read roadmap.md itself, as specs. An agent picks an item, writes a proposal for it, and once the proposal
  is approved, builds it in pull requests. Every item should say enough to build from without asking.

Everything in this folder is public, and the repository's privacy check scans it like every other file: no names,
email addresses or machine paths.

## An item

```markdown
### UDX-001 · Choose your colour scheme
status: idea · type: feature · area: app

Let users change UniDeX's colours by picking from a set of schemes: shades of blue, green, pink and more.
```

- **The heading** is the item's ID and a short title. IDs are `UDX-` and three or more digits.
- **The metadata line** comes straight under it: `status`, `type` and `area`, and `release` once it has shipped.
- **The prose** says what you want, in plain sentences. Its first paragraph is the summary.

Between the parts of the heading and of the metadata line, use whichever separator is easiest to type: `·`, `-`, `–`,
`—` or `|`. Keys and values aren't case-sensitive.

When an item is thought through, it gets sections under the prose. Any `####` heading works; these three are the usual
ones:

```markdown
### UDX-042 · Sample: not a real item
status: planned · type: improvement · area: cli

`aos` starts noticeably faster.

#### Must
- Starts in under a second on a warm cache

#### Not
- No background daemon

#### Done when
- `aos status` prints within one second, five runs in a row
```

**Must** is what it has to do. **Not** is what it shouldn't do or include yet. **Done when** is how anyone can tell it's
finished. A `#### Plan` section is welcome when you already know how it should be built.

## Fields

| Field | Values |
|---|---|
| `status` | `idea`, `planned`, `approved`, `building`, `shipped` (see below) |
| `type` | `feature` (something new you can use), `function` (a new capability under the hood or in the CLI), `improvement` (something existing, made better) |
| `area` | one lowercase word for where it lives: `app`, `cli`, `plugins`, `runtime`, `docs`… The page's area filter lists the areas in use. |
| `release` | `vX.Y.Z`, only on a shipped item; added for you by the release (below) |

## Statuses, and who moves them

| Status | Means | Set by |
|---|---|---|
| `idea` | Worth doing; the prose says what, not yet how. The agent's proposal fills in the gaps. | the owner, when adding the item |
| `planned` | Thought through: it has at least one `####` section. | the owner |
| `approved` | The agent's proposal for it was approved. | the agent, in a pull request (or folded into its first build PR) |
| `building` | Work is under way. | the agent, in its first pull request for the item |
| `shipped` | Merged. It shows under "Next release" until a release carries it. | the agent, in its last pull request for the item |

Statuses only move forward. The owner writes new items and edits their text; the agent changes only the status line,
and only inside its own pull requests, which the owner reviews. So nothing on the page changes without approval.

When a version is released, `npm run version:bump <x.y.z>` adds `release: v<x.y.z>` to every shipped item that doesn't
have one yet. Nobody needs to guess the version in advance.

## IDs

Give a new item the next number after the highest ID ever used. Once an item is public, don't delete it: an agent's
proposal or a pull request may already point at its ID. If one must go, its number stays retired. To check whether a
number was ever used:

```sh
git log -S 'UDX-007' --oneline -- roadmap/roadmap.md
```

## Checking and previewing

Every pull request runs `node tools/roadmap.js check`, which names the line of any problem: a duplicate or malformed
ID, an unknown status or type, a missing metadata line, a `planned` item with no section, or a `release` on an item that
hasn't shipped. To see the page before you push:

```sh
node tools/roadmap.js build --out _site
```

then open `_site/index.html` in a browser (`_site/` is ignored by git).

Linking to an item: the page opens one directly at `…/UniDeX-Agent-Harness/#UDX-001`.
