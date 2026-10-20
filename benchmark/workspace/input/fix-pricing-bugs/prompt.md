`pricing.py` (current directory) computes shopping-cart totals. Customers reported three bugs:

1. Carts with more than one item are charged too little.
2. A promo code with a 150% discount produced a negative total. Discounts must be clamped to 0–100%.
3. Totals must round half-up to the cent (e.g. 0.105 → 0.11), not banker's rounding.

Fix all three in `pricing.py`. Keep the public function names and signatures unchanged. Add tests for
each fix to `test_pricing.py`, and make sure `python3 -m unittest -v` passes. Use only the standard library.
