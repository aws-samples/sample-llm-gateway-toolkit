import unittest
from decimal import Decimal

from pricing import cart_total


class CartTotalTest(unittest.TestCase):
    def test_single_item(self):
        self.assertEqual(cart_total([{"price": "10.00", "qty": 1}]), Decimal("12.00"))


if __name__ == "__main__":
    unittest.main()
