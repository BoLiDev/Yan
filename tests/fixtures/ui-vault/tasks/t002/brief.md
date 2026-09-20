# t002 invoice export rounding

The PDF export of an invoice sometimes showed a total one cent away from the sum of
its lines, and an invoice note such as `</script><!-- x -->` came out mangled. The
PDF has to show what the ledger stores, whatever is typed into it.
