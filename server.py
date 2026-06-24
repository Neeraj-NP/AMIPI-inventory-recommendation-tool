import json
import os
import sys
import urllib.parse
import mimetypes
from http.server import HTTPServer, SimpleHTTPRequestHandler
import pandas as pd

# Explicitly map MIME types to prevent Windows Registry overrides from sending incorrect headers
mimetypes.init()
mimetypes.types_map['.js'] = 'application/javascript'
mimetypes.types_map['.css'] = 'text/css'

# Add the current directory to sys.path so we can import recommend
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from recommend import (
    load_data,
    calculate_recommendation,
    get_ai_reason,
    _fallback_reason,
    INVENTORY_FILE,
    MULTIPLIERS_FILE
)

PORT = int(os.environ.get("PORT", 8000))
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

class InventoryAPIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Initialize standard handler with the web directory as root
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        # Prevent caching for API development and testing
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        # Route API calls
        if self.path == "/api/inventory":
            self.handle_get_inventory()
        elif self.path == "/api/multipliers":
            self.handle_get_multipliers()
        else:
            # Fallback to serving static files
            super().do_GET()

    def do_POST(self):
        # Route API post calls
        if self.path == "/api/calculate":
            self.handle_post_calculate()
        elif self.path == "/api/save_multipliers":
            self.handle_post_save_multipliers()
        elif self.path == "/api/save_inventory":
            self.handle_post_save_inventory()
        else:
            self.send_error(404, "API endpoint not found")

    def handle_get_inventory(self):
        try:
            # Read inventory raw from CSV to ensure we don't drop any columns for the UI
            df_inv = pd.read_csv(INVENTORY_FILE)
            # Fill NaN values with empty string or sensible default
            df_inv = df_inv.fillna("")
            data = df_inv.to_dict(orient="records")
            self.send_json_response(data)
        except Exception as e:
            self.send_error_response(500, f"Error reading inventory: {str(e)}")

    def handle_get_multipliers(self):
        try:
            df_mult = pd.read_csv(MULTIPLIERS_FILE)
            data = df_mult.to_dict(orient="records")
            self.send_json_response(data)
        except Exception as e:
            self.send_error_response(500, f"Error reading multipliers: {str(e)}")

    def handle_post_calculate(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data) if post_data else {}

            custom_mults = payload.get("multipliers", {})
            use_ai = payload.get("use_ai", False)
            api_key = payload.get("api_key", None)
            inventory_override = payload.get("inventory", None)

            # Load either override inventory or fresh CSV inventory
            if inventory_override:
                df_inv = pd.DataFrame(inventory_override)
            else:
                df_inv = pd.read_csv(INVENTORY_FILE)

            # Validate required columns
            required_cols = ["style_number", "event", "days_until_event", "current_stock", "on_order", "last_90_day_sales"]
            missing_cols = [col for col in required_cols if col not in df_inv.columns]
            if missing_cols:
                self.send_error_response(400, f"Payload inventory missing required columns: {missing_cols}")
                return

            # Validate / Coerce numeric fields
            numeric_cols = ["last_90_day_sales", "current_stock", "on_order", "days_until_event"]
            for col in numeric_cols:
                if col in df_inv.columns:
                    df_inv[col] = pd.to_numeric(df_inv[col], errors="coerce").fillna(0)
                else:
                    df_inv[col] = 0

            # Get clean list of multipliers from request or CSV
            # Load fresh multipliers if not overridden
            if not custom_mults:
                df_mult = pd.read_csv(MULTIPLIERS_FILE)
                custom_mults = dict(zip(df_mult["event"].str.strip(), df_mult["event_multiplier"]))

            results = []
            for _, row in df_inv.iterrows():
                event_name = str(row["event"]).strip()
                # Get multiplier (default to 1.0 if not defined)
                try:
                    multiplier = float(custom_mults.get(event_name, 1.0))
                except (ValueError, TypeError):
                    multiplier = 1.0

                item = calculate_recommendation(row, multiplier)

                # Fetch AI or fallback reason
                if use_ai:
                    item["reason"] = get_ai_reason(item, api_key=api_key)
                else:
                    item["reason"] = _fallback_reason(item)

                results.append(item)

            self.send_json_response(results)

        except Exception as e:
            self.send_error_response(500, f"Error running calculations: {str(e)}")

    def handle_post_save_multipliers(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data) if post_data else []

            if not isinstance(payload, list):
                self.send_error_response(400, "Payload must be a list of event multipliers")
                return

            df = pd.DataFrame(payload)
            # Check required columns
            if not {"event", "event_multiplier"}.issubset(df.columns):
                self.send_error_response(400, "Payload missing required columns 'event' or 'event_multiplier'")
                return

            df.to_csv(MULTIPLIERS_FILE, index=False)
            self.send_json_response({"success": True, "message": "Multipliers saved successfully."})
        except Exception as e:
            self.send_error_response(500, f"Error saving multipliers: {str(e)}")

    def handle_post_save_inventory(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            payload = json.loads(post_data) if post_data else []

            if not isinstance(payload, list):
                self.send_error_response(400, "Payload must be a list of inventory items")
                return

            df = pd.DataFrame(payload)
            if df.empty or "style_number" not in df.columns:
                self.send_error_response(400, "Inventory payload is empty or missing 'style_number'")
                return
            # Retain the columns that were in the original CSV
            original_cols = ["style_number", "category", "metal", "stone_type", "last_30_day_sales",
                             "last_90_day_sales", "current_stock", "on_order", "event", "days_until_event", "season"]
            
            # Reorder / keep only valid columns, fill missing columns with defaults
            for col in original_cols:
                if col not in df.columns:
                    df[col] = ""
            df = df[original_cols]

            df.to_csv(INVENTORY_FILE, index=False)
            self.send_json_response({"success": True, "message": "Inventory saved successfully."})
        except Exception as e:
            self.send_error_response(500, f"Error saving inventory: {str(e)}")

    def send_json_response(self, data):
        response_bytes = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def send_error_response(self, code, message):
        response_bytes = json.dumps({"error": message}).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

def main():
    # Make sure static directory exists
    os.makedirs(WEB_DIR, exist_ok=True)
    
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, InventoryAPIHandler)
    print(f"🔷 AMIPI Inventory UI Server running at http://localhost:{PORT}/")
    print(f"   Serving static files from {WEB_DIR}")
    print("   Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n   Server stopped.")

if __name__ == "__main__":
    main()
