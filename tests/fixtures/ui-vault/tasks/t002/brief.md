# t002 invoice export rounding

## Description

The PDF export of an invoice sometimes showed a total one cent away from the sum of
its lines. The PDF now shows what the ledger stores.

## Deliverables

- [x] 08-05 · The rounding is done once, in the ledger, and the PDF prints what it stores.
- [x] 08-12 · MR !87 · A test renders every August invoice and compares the totals; a
  line such as `</script><!-- x -->` in an invoice note prints as typed.
- [x] 08-20 · PR #31 · The fix is documented for finance: replace `$&` and `$1` in the
  template engine's output with the literal text.
- [-] Re-sending the three wrong invoices — finance did it by hand.
