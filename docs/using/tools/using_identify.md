# Identify (`tool_identify`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_identify.md)

Identify answers one question about the record you have open: **which other records are most likely to be the same type as this one, and why**. It compares the record against the rest of the corpus you are allowed to read, ranks the candidates, and shows the reason for every single one, criterion by criterion.

## What it's for

Catalogues repeat themselves. A coin showing Athena with a palm and a star is the same type as another coin showing Athena with a palm and a star; an amphora with a given rim profile is the same typology as another with that profile; a photograph archive repeats the same people, symbols and places. Identify decomposes an object into the features that define it — a legend reached through the object's Type, a mint, a weight, a date — and looks for records that share them.

It **reads first and writes only when you confirm**. Everything it shows is a proposal with its reasons attached; nothing changes in the catalogue until you press a button that says what it will write. Deciding that two records really are the same type stays a curatorial act — the panel just stops it being thirty acts (see [Grouping a batch, and promoting a Type](#grouping-a-batch-and-promoting-a-type)).

Concrete scenario: a numismatist opens a newly catalogued coin, runs Identify, and gets three candidates. The first is marked *Same type* at 100%: same obverse legend, same reverse deity, weight within tolerance. The second is a *Candidate* at 62%: same legend, but the reverse deity differs. The third is *Weak*: the only thing it shares is the mint. The curator opens the first candidate in a new window, compares the two photographs side by side, and records the type relation by hand.

## When to use it

- You have just catalogued a record and want to know whether the collection already holds its type.
- You suspect two objects were struck from the same die, or come from the same workshop, and want the shared features listed explicitly.
- You are triaging an import batch and need to spot the duplicates it introduced.

When *not* to use it:

- To search by field values — use the section's own search panel.
- To edit records generally: the only thing Identify writes is the confirmation you explicitly press (a suggested value, or the Type link of a group).
- To find visually similar images: the ranked list compares **catalogued features**, not pixels (grouping a batch also uses the image index, when the collection has one).

## Where to find it

Identify is an **inspector** button: open a record in edit mode, and it appears in the inspector panel for that record. It opens as a modal over the record, so the record stays loaded behind it.

It needs a **saved** record to work on. Opened on a record that has never been saved, it says so rather than comparing nothing.

## Using it, step by step

1. Open the object record in edit mode.
2. Open **Identify** from the inspector.
3. The comparison starts by itself. The top strip shows the record being compared and the **profile** used (see below).
4. Read the candidates, best first. Each one shows a verdict, the record's title, a score and its full breakdown.
5. Use **Open this record** (or click the title or the thumbnail) to open a candidate in its own window and compare it properly.
6. If you edit the record while the panel is open, the **Find matches** button is highlighted: the ranking you are looking at was computed from values that may have changed. Press it to run the comparison again.

## Reading a result

### The verdict

Each candidate carries one of three words. Read the word, not just the colour or the number:

| Verdict | Meaning |
| --- | --- |
| **Same type** | The candidate agrees on at (or above) the profile's *same type* threshold. It is a strong proposal — still a proposal. |
| **Candidate** | Enough agreement to be worth your attention, not enough to be called the same type. |
| **Weak** | It shares something, but little. It is shown so that "nothing was found" is never confused with "nothing was compared". |

The thresholds are part of the profile, so the same score means different things in different collections. That is deliberate: what makes two objects "the same" is curatorial knowledge, not a universal constant.

### The score

The score is a percentage of the **identifying weight that was achievable for this pair** — not a percentage of the profile, and not a probability. Criteria that neither record states are excluded from the calculation entirely (see below), so a sparsely catalogued record is not punished for being sparse. Criteria marked *descriptive* are shown with their result but contribute nothing to the score.

Criteria marked **required** contribute nothing to the score either, for a different reason: they decide *who gets in*, not *how well they did*. A candidate that does not share a required criterion is not shown at all, so every candidate you are reading already agrees on it — scoring it would add the same points to every row and quietly push all of them toward *Same type*. The score therefore measures only the criteria that actually tell the candidates apart. If a profile's sole identifying criterion is a required one, everything that passed it scores 100%: it agreed on everything that profile is able to judge.

Each row therefore ends with one of three statements about what that criterion did to the score, and they are not degrees of the same thing:

| Marker | What it means |
| --- | --- |
| **gate — required, not part of the score** | The criterion that decided who is on this list at all. Every candidate you can see agreed on it. It is the *strongest* thing in the profile, and it is out of the score precisely because it ranks nothing. |
| **weight n** | It contributed `n` to the comparison — this is what actually separates the candidates. |
| **descriptive — shown, not scored** | Reported for context (findspot, condition, an inventory number) and deliberately never scored. |

A gate and a descriptive criterion are opposites, so if you are authoring a profile: **never set a required criterion's weight to 0 to express that it is not scored.** The engine already excludes it and the panel already says *gate*; zeroing the weight only makes the profile's backbone read as its least important field.

### The breakdown: "not recorded" is not "differed"

Every candidate lists every criterion with one of four results. **This is the part most easily misread, so it is worth being precise about:**

| Row | What it means |
| --- | --- |
| **Agreed** | Both records state this, and the values match under the criterion's comparison rule. |
| **Differed** | Both records state this, and the values do **not** match. This is a real disagreement, and it lowered the score. |
| **Not recorded** | At least one of the two records says nothing at all here. |
| **Not readable by you** | You do not have permission to read this field, so it was not compared and its value is not shown. |

*Not recorded* is **absence, not disagreement**. It is not a small mismatch and not a weak agreement: nobody wrote the value down, so the criterion could not discriminate, and it was left out of the score in both directions. It neither helped nor hurt. Every such row repeats that in plain words, because reading it as a mismatch turns a half-catalogued record into a false negative — and half-catalogued records are exactly what identification is for.

A worn coin whose obverse legend was never legible is not a worse match for lacking one. It is simply a record with less to compare.

*Not readable by you* is **not** absence either, and the difference matters more than it looks. The field may be fully catalogued; you simply have no permission on it, so the engine refused to compare it and refused to quote it. It tells you nothing about your collection — only about your own access. Reading it as "nobody recorded this" is how a curator concludes a catalogue is empty where it is merely closed to them.

## The three honesty notices

Three messages can appear above the list. They exist so the ranking cannot quietly over-claim, and all three are worth reading before you trust the order:

- **"This record states nothing for the criteria below…"** — the *blind criteria*. Those criteria are empty **on the record you are identifying**, so they discriminated nothing at all and the score was computed without them. A high score with three blind criteria is a high score over what was left. If the list is long, the fastest way to improve the results is to catalogue those fields on this record.
- **"You do not have permission to read the criteria below…"** — the *restricted criteria*. Those criteria were skipped because of **your permissions**, not because of the data, so every score on screen is **partial**: it was computed over the criteria you may see, and a colleague with broader access will see a different number for the same two records. If a criterion matters to your work, ask an administrator for the grant rather than reading the field as empty.
- **"More candidates exist than were scored"** — the comparison is capped, and the cap stopped it. The list you are reading is not the whole corpus. It is deliberately not a number: the engine only asks "is there more?", so it can honestly say *more* but never *how many*.

## The thumbnails

When the profile declares which media component holds the object's photograph, the record being identified and each candidate show its thumbnail. The picture supports the breakdown; it never replaces it — the criteria are still the argument.

A neutral, dashed placeholder means there is no image to show: either the profile declares no photograph component, or this particular record has none generated. It is not an error, and it says nothing about the match.

## When it says the section has no profile

You will see: *"This section has no identification profile configured, so there is nothing to compare on."*

That is a normal answer, not a fault. A **profile** states what identifies an object in this collection — which fields count, how strictly each is compared, how much each weighs, which are mandatory — and it is curatorial knowledge that has to be authored. Without one, the engine has no opinion about what "the same type" means here, and refuses to invent one.

To get it configured, ask an administrator to add the identification descriptor to the section's ontology properties. Bring them the answers only a curator has:

- which fields identify an object of this kind (including fields reached *through* another record, such as the object's Type);
- which of them are mandatory for a candidate to be considered at all;
- how each is compared — the exact same linked record, the same text ignoring case and accents, a number within a tolerance, overlapping dates;
- how much each one weighs, and the two thresholds;
- which media component holds the object's photograph, if you want the thumbnails.

The related message *"This section's identification profile could not be read"* is different: a profile **exists** but is wrong, and the panel prints the exact problem underneath. Nothing was compared, on purpose — a profile that silently drops a criterion would keep producing confident scores computed from fewer features than were configured. Send that message verbatim to an administrator.

## Grouping a batch, and promoting a Type

The ranked list answers "what else is like **this** record?". After an import you have the other question — *which of these two hundred are the same thing?* — and **Groups in this batch** answers it in one run.

### Grouping

Press **Group these records**. It compares the records of your current filter (up to the number shown next to the button) and returns the groups inside them. Each group tells you:

- **how many records** are in it, and which signals produced it — *images* (near-identical photographs) or *criteria* (agreement on the profile's fields), or both;
- **what the members agree on**, criterion by criterion, with the same four honest states as everywhere else — agreed, partial, differs, and *not recorded* (absence, never disagreement);
- **the shape of the group**: the share of member pairs that are *directly* linked, the longest chain inside it, and the weakest link holding it together;
- **the links themselves** — the literal list of "A and B, 94%, because their photographs are near-identical".

!!! warning
    A group can be a **chain**: A resembles B and B resembles C, so all three are grouped, even when A and C have nothing in common. Those groups are marked, and the "longest chain" number tells you how far the chaining went. Read the links before accepting a chained group whole.

Records that grouped with nothing are listed too. "This one is on its own" is an answer.

### Promoting a group to a Type

If your collection keeps canonical **Type** records, a group can become one. **Promote to a Type…** offers exactly two paths:

- **an existing Type** — the panel lists the Types the group's members already link to, most common first (usually the one you want, because a typology is usually already catalogued), or any other Type by its record id, which you check before using so a typo cannot attach thirty records to the wrong Type;
- **a new Type record**, minted in the Type section and named right there when that section's title is a plain text field.

Then it links every member to it, writing into the component your section's identification profile says is the Type link — never a component the panel picked because it looked plausible.

Before anything is written you get a **review**: what will be written, into which component, on how many records, with the records named. The confirm button says the number out loud.

Afterwards you get one line per record — **linked**, **already linked** (it pointed at that Type before you started, so nothing was written), or **FAILED** with the server's own reason. Failures stay on screen with a **Retry** that runs only them. Nothing is ever reported as a bare "done": if three of thirty could not be saved, you see which three.

### When promotion is not offered

The button is absent, and a line says why. Each of these is a fact about the collection or your permissions, not a fault:

- *"This collection keeps no canonical Type records"* — the profile declares no Type section. Grouping still works; there is simply nothing to promote into (a photograph archive is the normal case).
- *"The identification profile does not say which component links a record to its Type"* — no criterion in the profile reaches the Type section in one hop, so the engine cannot tell which of the section's fields is the Type link, and refuses to guess. An administrator adds a criterion whose path starts on the object and hops into the Type section.
- *"You may read this section but not write …"* — the link field is read-only for you.

## Tips and gotchas

!!! tip
    Read the breakdown before the score. Two candidates at 80% can be completely different propositions — one agreeing on three strong criteria, the other on one strong criterion with the rest not recorded.

!!! warning
    Candidates you are not allowed to read are simply absent. There is no "3 hidden" line anywhere, and there will never be one: a count of what you cannot see is itself a leak. If a colleague sees a candidate you do not, that is a permissions difference, not a bug.

!!! note
    Everything Identify writes goes through the ordinary component save, exactly as if you had typed or picked the value in the record's own form: same history entry in the Time machine, same permission check, same effect on publication. There is no special "bulk" path, which is why a failure is reported per record instead of as one number.

## Related

- **[Cataloging](using_cataloging.md)** — assemble records into a hierarchy by hand, once you know what belongs together.
- **[Time machine](using_time_machine.md)** — check what a record's values looked like before an edit changed a comparison.
- **[Developer reference](../../development/tools/reference/tool_identify.md)** — the API contract, the profile descriptor and the registration.
