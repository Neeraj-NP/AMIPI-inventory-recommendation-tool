"""
AMIPI Inventory Recommendation Tool
Project 3: Event-aware restocking recommendations for jewelry inventory.

Author: Candidate Submission
Usage:
    python recommend.py                          # Run all items, interactive event selection
    python recommend.py --event "JCK Vegas"      # Filter by specific event
    python recommend.py --style B401400-14WVS    # Single style lookup
    python recommend.py --output csv             # Export results to CSV
    python recommend.py --output json            # Export results to JSON
"""

import argparse
import json
import math
import os
import sys
import textwrap
from datetime import datetime
from typing import Optional

import pandas as pd
import requests

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
INVENTORY_FILE = os.path.join(DATA_DIR, "inventory_sales.csv")
MULTIPLIERS_FILE = os.path.join(DATA_DIR, "event_multipliers.csv")
OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), "outputs")

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
GEMINI_MODEL = "gemini-2.5-flash"

os.makedirs(OUTPUTS_DIR, exist_ok=True)


# ─────────────────────────────────────────────
# Data Loading & Validation
# ─────────────────────────────────────────────
def load_data() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load and validate inventory and event multiplier CSVs."""
    required_inventory_cols = {
        "style_number", "last_90_day_sales", "current_stock",
        "on_order", "event", "days_until_event"
    }
    required_multiplier_cols = {"event", "event_multiplier"}

    if not os.path.exists(INVENTORY_FILE):
        raise FileNotFoundError(f"Inventory file not found: {INVENTORY_FILE}")
    if not os.path.exists(MULTIPLIERS_FILE):
        raise FileNotFoundError(f"Event multipliers file not found: {MULTIPLIERS_FILE}")

    inventory = pd.read_csv(INVENTORY_FILE)
    multipliers = pd.read_csv(MULTIPLIERS_FILE)

    missing_inv = required_inventory_cols - set(inventory.columns)
    if missing_inv:
        raise ValueError(f"Inventory CSV is missing columns: {missing_inv}")

    missing_mul = required_multiplier_cols - set(multipliers.columns)
    if missing_mul:
        raise ValueError(f"Multipliers CSV is missing columns: {missing_mul}")

    # Numeric type coercion with error reporting
    numeric_cols = ["last_90_day_sales", "current_stock", "on_order", "days_until_event"]
    for col in numeric_cols:
        inventory[col] = pd.to_numeric(inventory[col], errors="coerce")
        bad_rows = inventory[inventory[col].isna()]
        if not bad_rows.empty:
            print(f"  ⚠ Warning: {len(bad_rows)} row(s) have non-numeric '{col}', will be skipped.")

    inventory = inventory.dropna(subset=numeric_cols)
    inventory[numeric_cols] = inventory[numeric_cols].astype(float)

    return inventory, multipliers


# ─────────────────────────────────────────────
# Deterministic Calculation Engine
# ─────────────────────────────────────────────
def calculate_recommendation(row: pd.Series, event_multiplier: float) -> dict:
    """
    Apply the deterministic formulas specified in the project brief.
    All numeric logic is rule-based — no AI involved here.
    """
    available_inventory = row["current_stock"] + row["on_order"]
    monthly_sales_rate = row["last_90_day_sales"] / 3
    projected_demand = monthly_sales_rate * (row["days_until_event"] / 30)
    recommended_stock_needed = projected_demand * event_multiplier
    suggested_order_qty = max(0, round(recommended_stock_needed - available_inventory))

    # Priority Rules (checked in order; "Do Not Reorder" overrides all)
    if row["last_90_day_sales"] <= 3 and row["current_stock"] >= 8:
        priority = "Do Not Reorder"
        recommendation = "Hold"
    elif suggested_order_qty >= 5 or (row["current_stock"] <= 2 and row["last_90_day_sales"] >= 10):
        priority = "High"
        recommendation = "Reorder Urgently"
    elif 2 <= suggested_order_qty <= 4 or (row["current_stock"] <= 3 and row["last_90_day_sales"] >= 6):
        priority = "Medium"
        recommendation = "Reorder"
    else:
        priority = "Low"
        recommendation = "Monitor"

    return {
        "style_number": row["style_number"],
        "category": row.get("category", ""),
        "metal": row.get("metal", ""),
        "stone_type": row.get("stone_type", ""),
        "event": row["event"],
        "days_until_event": int(row["days_until_event"]),
        "available_inventory": int(available_inventory),
        "current_stock": int(row["current_stock"]),
        "on_order": int(row["on_order"]),
        "last_90_day_sales": int(row["last_90_day_sales"]),
        "monthly_sales_rate": round(monthly_sales_rate, 2),
        "projected_demand_until_event": round(projected_demand, 2),
        "event_multiplier": event_multiplier,
        "recommended_stock_needed": round(recommended_stock_needed, 2),
        "suggested_order_qty": int(suggested_order_qty),
        "priority": priority,
        "recommendation": recommendation,
    }


# ─────────────────────────────────────────────
# AI Reason Generation (Anthropic API)
# ─────────────────────────────────────────────
def build_ai_prompt(item: dict) -> str:
    """Construct a prompt for AI-generated business reason in jewelry-retail language."""
    return textwrap.dedent(f"""
        You are a senior merchandising analyst at a fine jewelry company.
        Write a single concise sentence (max 25 words) explaining the restock recommendation 
        for this jewelry item.
        
        CRITICAL: Use rich, professional jewelry-retail and merchandising terminology. Incorporate concepts like:
        - "showcase depth", "showcase presentation", "assortment mix", "core collection"
        - "sell-through velocity", "turn rate", "open-to-buy budget"
        - "stockout risk", "vendor lead times", "holiday demand curves"
        - Mention the specific metal (e.g. 18K white gold, platinum, 14K yellow gold) and gemstone (e.g. lab grown diamond, natural diamond, ruby, emerald) characteristics if applicable.
        
        Item details:
        - Style: {item['style_number']}
        - Category: {item['category']} | Metal: {item['metal']} | Stone: {item['stone_type']}
        - Upcoming event: {item['event']} (in {item['days_until_event']} days)
        - Last 90-day sales: {item['last_90_day_sales']} units
        - Available inventory: {item['available_inventory']} units
        - Suggested order qty: {item['suggested_order_qty']} units
        - Priority: {item['priority']}
        - Recommendation: {item['recommendation']}
        
        Respond with ONLY the reason sentence, no preamble or labels.
    """).strip()


def get_ai_reason(item: dict, api_key: Optional[str] = None) -> str:
    """
    Call the Gemini API to generate a business reason.
    Falls back to a deterministic template if the API is unavailable.
    """
    if not api_key:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")

    if not api_key:
        return _fallback_reason(item)

    prompt = build_ai_prompt(item)
    try:
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key
        }
        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        }
                    ]
                }
            ],
            "generationConfig": {
                "maxOutputTokens": 100
            }
        }
        response = requests.post(
            GEMINI_API_URL,
            headers=headers,
            json=payload,
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()

    except requests.exceptions.ConnectionError:
        return _fallback_reason(item)
    except requests.exceptions.Timeout:
        return _fallback_reason(item)
    except Exception as e:
        print(f"  ⚠ AI API error for {item['style_number']}: {e}. Using fallback reason.")
        return _fallback_reason(item)


def _fallback_reason(item: dict) -> str:
    """Deterministic fallback reason when AI API is unavailable using premium jewelry merchandising terms."""
    category = item.get("category", "style").lower()
    metal = item.get("metal", "")
    stone = item.get("stone_type", "fine jewelry").lower()
    event = item["event"]
    sales = item["last_90_day_sales"]
    stock = item["current_stock"]
    qty = item["suggested_order_qty"]

    # Combine metal, stone, and category for a natural description
    desc_parts = [metal, stone, category]
    desc = " ".join([p for p in desc_parts if p]).strip().replace("  ", " ")

    if item["priority"] == "Do Not Reorder":
        return (f"Hold open-to-buy budget. Low turn rate ({sales} units sold in 90 days) and ample "
                f"on-hand inventory ({stock} units) of this {desc} warrants holding showcase position ahead of {event}.")
    
    if item["priority"] == "High":
        return (f"Critical stockout risk for this high-velocity {desc}. Thin showcase depth ({stock} on-hand) "
                f"requires immediate vendor replenishment of {qty} units to meet anticipated {event} demand curves.")
    
    if item["priority"] == "Medium":
        return (f"Moderate sell-through velocity and lean showcase coverage of this {desc} warrants a replenishment of "
                f"{qty} units to optimize core collection presentation for {event}.")
    
    return (f"Sufficient showcase depth ({stock} units on-hand) for this {desc}; monitor sell-through velocity approaching {event}.")


# ─────────────────────────────────────────────
# Display Helpers
# ─────────────────────────────────────────────
PRIORITY_COLOR = {
    "High": "\033[91m",          # red
    "Medium": "\033[93m",        # yellow
    "Low": "\033[92m",           # green
    "Do Not Reorder": "\033[90m" # grey
}
RESET = "\033[0m"


def color(text: str, priority: str) -> str:
    return f"{PRIORITY_COLOR.get(priority, '')}{text}{RESET}"


def print_result(item: dict) -> None:
    p = item["priority"]
    print()
    print(color(f"  ▸ {item['style_number']}  [{item['recommendation']}]  Priority: {p}", p))
    print(f"    Category: {item['category']}  |  Metal: {item['metal']}  |  Stone: {item['stone_type']}")
    print(f"    Event: {item['event']} in {item['days_until_event']} days  |  Multiplier: {item['event_multiplier']}×")
    print(f"    90-day sales: {item['last_90_day_sales']}  |  "
          f"In stock: {item['current_stock']}  |  On order: {item['on_order']}  |  "
          f"Available: {item['available_inventory']}")
    print(f"    Monthly rate: {item['monthly_sales_rate']}  |  "
          f"Projected demand: {item['projected_demand_until_event']}  |  "
          f"Needed: {item['recommended_stock_needed']}")
    print(color(f"    ➜ Order qty: {item['suggested_order_qty']}  |  {item['reason']}", p))


def print_summary(results: list[dict]) -> None:
    counts = {"High": 0, "Medium": 0, "Low": 0, "Do Not Reorder": 0}
    total_units = 0
    for r in results:
        counts[r["priority"]] = counts.get(r["priority"], 0) + 1
        total_units += r["suggested_order_qty"]

    print("\n" + "═" * 60)
    print("  SUMMARY")
    print("═" * 60)
    for p, c in counts.items():
        print(f"  {color(p, p):<30} {c} item(s)")
    print(f"  Total units to order:          {total_units}")
    print("═" * 60)


# ─────────────────────────────────────────────
# Core Pipeline
# ─────────────────────────────────────────────
def run(event_filter: Optional[str] = None, style_filter: Optional[str] = None,
        output_format: Optional[str] = None, use_ai: bool = True, api_key: Optional[str] = None) -> list[dict]:
    """Main pipeline: load → calculate → AI reason → display → export."""

    print("\n🔷 AMIPI Inventory Recommendation Tool")
    print("  Loading data …")

    inventory, multipliers = load_data()

    # Build event → multiplier lookup
    multiplier_map: dict[str, float] = dict(
        zip(multipliers["event"].str.strip(), multipliers["event_multiplier"])
    )

    # Apply filters
    df = inventory.copy()
    if event_filter:
        df = df[df["event"].str.strip().str.lower() == event_filter.lower()]
        if df.empty:
            valid = ", ".join(multiplier_map.keys())
            print(f"  ⚠ No items found for event '{event_filter}'. Valid events: {valid}")
            return []

    if style_filter:
        df = df[df["style_number"].str.strip().str.upper() == style_filter.upper()]
        if df.empty:
            print(f"  ⚠ Style '{style_filter}' not found in inventory.")
            return []

    print(f"  Processing {len(df)} item(s) …\n")
    print("═" * 60)

    results = []
    for _, row in df.iterrows():
        event_name = row["event"].strip()
        if event_name not in multiplier_map:
            print(f"  ⚠ No multiplier found for event '{event_name}' — skipping {row['style_number']}.")
            continue

        item = calculate_recommendation(row, multiplier_map[event_name])

        # AI reason generation (or fallback)
        if use_ai:
            item["reason"] = get_ai_reason(item, api_key=api_key)
        else:
            item["reason"] = _fallback_reason(item)

        results.append(item)
        print_result(item)

    print_summary(results)

    # Export
    if output_format and results:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        if output_format == "json":
            path = os.path.join(OUTPUTS_DIR, f"recommendations_{timestamp}.json")
            with open(path, "w") as f:
                json.dump(results, f, indent=2)
            print(f"\n  ✓ JSON saved → {path}")
        elif output_format == "csv":
            path = os.path.join(OUTPUTS_DIR, f"recommendations_{timestamp}.csv")
            pd.DataFrame(results).to_csv(path, index=False)
            print(f"\n  ✓ CSV saved → {path}")

    return results


# ─────────────────────────────────────────────
# CLI Entry Point
# ─────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="AMIPI Inventory Recommendation Tool — Project 3"
    )
    parser.add_argument("--event", type=str, help="Filter by event name (e.g. 'JCK Vegas')")
    parser.add_argument("--style", type=str, help="Filter by style number")
    parser.add_argument("--output", choices=["json", "csv"], help="Export format")
    parser.add_argument("--no-ai", action="store_true", help="Skip AI reason generation (use deterministic fallback)")
    args = parser.parse_args()

    try:
        run(
            event_filter=args.event,
            style_filter=args.style,
            output_format=args.output,
            use_ai=not args.no_ai,
        )
    except FileNotFoundError as e:
        print(f"\n  ✗ File error: {e}")
        sys.exit(1)
    except ValueError as e:
        print(f"\n  ✗ Data error: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n  Cancelled.")
        sys.exit(0)


if __name__ == "__main__":
    main()
