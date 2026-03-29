# Shirt SKU Rules Reference

## Prefix positions

The parser reads the first four SKU characters as fixed positions:

1. Position 0: category
2. Position 1: fabric
3. Position 2: collar
4. Position 3: fit

Example:

`MTSE` means:

- `M` = Mens
- `T` = Twill
- `S` = Spread
- `E` = Extra Slim

## Category codes

- `B` = Boys
- `M` = Mens
- `W` = Womans
- `G` = Girls

## Fabric codes

- `T` = Twill
- `J` = J-Twill
- `D` = Dobby
- `P` = Pinpoint
- `O` = Oxford
- `K` = Knit Stretch

Fabric name adjustments:

- Add `Clean ` prefix when SKU contains `CLN`
- Add `Soft ` prefix when SKU contains `DP` and the second SKU character is `T`
- Add ` Stretch` suffix when SKU contains `STRETCH`

Examples:

- `MT...` = `Twill`
- `MT...-DP-...` = `Soft Twill`
- `MT...-CLN-...` = `Clean Twill`
- `MT...-STRETCH-...` = `Twill Stretch`

## Collar codes

- `S` = Spread
- `C` = Cutaway
- `V` = Extra Cutaway
- `B` = Button
- `P` = Pointy

## Fit codes

- `H` = Husky
- `T` = Traditional
- `C` = Classic
- `S` = Slim
- `E` = Extra Slim
- `X` = Super Slim
- `R` = Classic

## Optional flags

- `CLN` = clean finish
- `DP` = soft twill handling in combination with twill
- `STRETCH` = append `Stretch` to fabric
- `FC` = French cuff
- `SS` = Short Sleeve
- `PKT` = pocket present
- `ROL` = Chassidish style

Derived values:

- `clean` = `Yes` if `CLN` is present, else `No`
- `cuff` = `French` if `FC` is present
- `cuff` = `Short Sleeve` if `SS` is present and `FC` is absent
- `cuff` = `Button` otherwise
- `style` = `Chassidish` if `ROL` is present, else `Standard`
- `pocket` = `true` when `PKT` is present

## Color rules

If the SKU contains a segment with `CNT`, the parser maps that segment through the color dictionary. If no `CNT...` segment exists, color defaults to `White`.

Base color mappings:

- `CNT8` = Periwinkle Petal
- `CNT9` = Powder Dot
- `CNT10` = Navy Trellis
- `CNT4` = Royal Blue
- `CNT6` = Golden Weave
- `CNT5` = Midnight Tide
- `CNT7` = Night Prism
- `CNT1` = Mini Check
- `CNT2` = Blue Plaid
- `CNT3` = Blue Diamond

Short-sleeve color mappings:

- `CNT1SS` = Sky Blue
- `CNT2SS` = Espresso
- `CNT4SS` = Royal Blue
- `CNT8SS` = Periwinkle Petal
- `CNT9SS` = Powder Dot

## Size and sleeve parsing

The parser takes the last hyphen-delimited segment and calls it `lastElement`.

### Size

Size is parsed from the first two characters of `lastElement`, after removing `DP`.

Rule:

- take the first two digits
- add `.5` if `lastElement` contains `H`

Examples:

- `16534` -> size `16`
- `16H34` -> size `16.5`
- `15H33` -> size `15.5`

### Sleeve length

Sleeve length is only parsed for mens non-short-sleeve SKUs.

Rule:

- if category is not `M`, sleeve length is `N/A`
- if SKU includes `SS`, sleeve length is `Short Sleeve`
- otherwise take the end of `lastElement`
- if SKU includes `/`, take the last 5 characters
- otherwise take the last 2 characters

Examples:

- mens SKU ending in `16534` -> sleeve `34`
- mens SKU ending in `16H35` -> sleeve `35`
- mens short sleeve SKU -> `Short Sleeve`

## White shirt rule

A plain white shirt usually has no `CNT...` segment at all. That means:

- `MTSE` = Mens Twill Spread Extra Slim White
- `MTSE-16534` = Mens Twill Spread Extra Slim White, size 16, sleeve 34

## Worked examples

### Example 1

Phrase: `mens twill spread extra slim white shirt`

Decoded prefix:

- `M` mens
- `T` twill
- `S` spread
- `E` extra slim

Result:

- prefix = `MTSE`
- white is implicit because there is no `CNT...` color segment

### Example 2

SKU: `MTSE-FC-PKT-16H35`

Meaning:

- Mens
- Twill
- Spread
- Extra Slim
- White
- French cuff
- Pocket
- Size 16.5
- Sleeve 35

### Example 3

SKU: `MTSE-CNT4-16534`

Meaning:

- Mens
- Twill
- Spread
- Extra Slim
- Royal Blue
- Size 16
- Sleeve 34

## Answering guidance

When a user asks what a shirt description means:

1. Map the spoken attributes to the first four prefix characters.
2. Say whether color is explicit or default white.
3. Mention any missing information such as size, sleeve, cuff, or color code.

When a user asks what a SKU means:

1. Decode the first four characters first.
2. Decode optional segments next.
3. Parse the last segment last because it mixes size and sleeve information.
