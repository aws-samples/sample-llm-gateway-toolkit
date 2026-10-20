"""Hidden grading tests: copied in after the agent finishes; the agent never sees this file."""
import unittest
from decimal import Decimal

from pricing import cart_total

CART = [{"price": "2.50", "qty": 2}, {"price": "1.00", "qty": 1}]  # subtotal 6.00


class HiddenTest(unittest.TestCase):
    def test_multi_item(self):
        self.assertEqual(cart_total(CART), Decimal("7.20"))

    def test_empty_cart(self):
        self.assertEqual(cart_total([]), Decimal("0.00"))

    def test_discount_clamped_high(self):
        self.assertEqual(cart_total(CART, 150), Decimal("0.00"))

    def test_discount_clamped_low(self):
        self.assertEqual(cart_total(CART, -10), Decimal("7.20"))

    def test_round_half_up(self):
        # 0.10 - 12.5% = 0.0875; + 20% tax = 0.105 -> 0.11 (half-even would give 0.10)
        self.assertEqual(cart_total([{"price": "0.10", "qty": 1}], 12.5), Decimal("0.11"))


if __name__ == "__main__":
    unittest.main()
