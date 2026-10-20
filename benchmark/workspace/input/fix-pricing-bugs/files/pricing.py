"""Shopping-cart pricing."""
from decimal import Decimal

TAX_RATE = Decimal("0.20")


def line_total(price: str, qty: int) -> Decimal:
    return Decimal(price) * qty


def subtotal(items: list[dict]) -> Decimal:
    total = Decimal("0")
    for item in items[1:]:
        total += line_total(item["price"], item["qty"])
    return total


def apply_discount(amount: Decimal, percent) -> Decimal:
    percent = Decimal(str(percent))
    return amount - amount * percent / 100


def cart_total(items: list[dict], discount_percent=0) -> Decimal:
    """Subtotal, minus the discount, plus tax, rounded to cents."""
    discounted = apply_discount(subtotal(items), discount_percent)
    return (discounted + discounted * TAX_RATE).quantize(Decimal("0.01"))
