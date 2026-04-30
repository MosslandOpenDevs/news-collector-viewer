from __future__ import annotations

import argparse
import time
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode, urlparse, urlunparse, parse_qsl

from PIL import Image
from playwright.sync_api import sync_playwright


def with_refresh(url: str) -> str:
    parsed = urlparse(url)
    qs = dict(parse_qsl(parsed.query, keep_blank_values=True))
    qs["refresh"] = str(int(time.time()))
    return urlunparse(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            urlencode(qs),
            parsed.fragment,
        )
    )


def build_url(html_path: Path) -> str:
    return with_refresh(html_path.resolve().as_uri())


def ensure_cards(page, minimum: int = 10, timeout_ms: int = 120000) -> None:
    page.wait_for_selector(".hotCard", timeout=timeout_ms)
    elapsed = 0
    step = 250
    while elapsed < timeout_ms:
        if page.locator(".hotCard").count() >= minimum:
            return
        page.wait_for_timeout(step)
        elapsed += step


def force_language(page, lang: str, min_cards: int, timeout_ms: int = 180000) -> None:
    target = "en" if lang == "en" else "ko"
    page.wait_for_selector("#langToggle", timeout=timeout_ms)
    current = page.evaluate("document.documentElement.lang || ''")
    if current != target:
        page.locator("#langToggle").click()
    page.wait_for_function(
        """target => document.documentElement.lang === target""",
        arg=target,
        timeout=timeout_ms,
    )
    ensure_cards(page, minimum=min_cards, timeout_ms=timeout_ms)
    if target == "en":
        page.wait_for_function(
            """
            minCards => {
              const cards = Array.from(document.querySelectorAll('.hotCard')).slice(0, minCards);
              if (cards.length < minCards) return false;
              const text = cards.map(card => card.innerText || '').join('\\n');
              return text && !/[가-힣]/.test(text);
            }
            """,
            arg=min_cards,
            timeout=timeout_ms,
        )


def apply_capture_width(page, content_width: int | None) -> None:
    if not content_width:
        return
    shell_width = max(content_width, min(1120, content_width + 120))
    page.evaluate(
        """
        ({ contentWidth, shellWidth }) => {
          const style = document.createElement('style');
          style.setAttribute('data-export-width-fix-v1', '1');
          style.textContent = `
            .blogShell {
              --content-width: ${contentWidth}px !important;
              width: ${shellWidth}px !important;
              max-width: ${shellWidth}px !important;
            }
            .hotScroller,
            .hotHeader,
            .heroThumb,
            .pageFooter {
              width: ${contentWidth}px !important;
            }
          `;
          document.head.appendChild(style);
        }
        """,
        {"contentWidth": int(content_width), "shellWidth": int(shell_width)},
    )


def export_thumbnail(page, out_path: Path) -> None:
    page.wait_for_selector(".heroThumb", timeout=120000)
    for _ in range(120):
        label = (page.locator("#heroWeekLabel").inner_text() or "").strip()
        if label:
            break
        page.wait_for_timeout(250)
    page.evaluate(
        """
        () => {
          const style = document.createElement('style');
          style.setAttribute('data-export-thumb-fix-v1', '1');
          style.textContent = `
            html, body, .blogShell, .heroSection {
              background: transparent !important;
              background-color: transparent !important;
              background-image: none !important;
            }
            .heroThumb {
              box-shadow: none !important;
              filter: none !important;
            }
          `;
          document.head.appendChild(style);
        }
        """
    )
    page.wait_for_timeout(300)
    page.locator(".heroThumb").screenshot(path=str(out_path), type="png", omit_background=True)


def export_body(page, out_path: Path) -> None:
    page.evaluate(
        """
        () => {
          const style = document.createElement('style');
          style.setAttribute('data-export-fix-v3', '1');
          style.textContent = `
            html, body, .blogShell, .blogMain, .blogPanel, .stage, #grid, .hotScroller {
              background: transparent !important;
              background-color: transparent !important;
              background-image: none !important;
            }
            .blogPanel::before, .blogPanel::after,
            .stage::before, .stage::after,
            .hotScroller::before, .hotScroller::after {
              content: none !important;
              display: none !important;
              background: transparent !important;
            }
            .hotScroller { padding: 10px 0 !important; }
            .hotCard {
              box-shadow: none !important;
              min-height: auto !important;
            }
            .hotCardSourceImage {
              flex-basis: 154px !important;
              width: 154px !important;
              height: 108px !important;
            }
            .hotCard {
              padding-left: 22px !important;
              padding-right: 20px !important;
            }
            .hotSummaryFrame {
              gap: 22px !important;
            }
            .hotHeadline {
              font-size: 29px !important;
              line-height: 1.18 !important;
            }
            .hotDesc {
              font-size: 17px !important;
              line-height: 1.48 !important;
            }
            .summaryLabel,
            .hotSource,
            .hotMeta {
              font-size: 12px !important;
            }
            .hotRank {
              font-size: 15px !important;
              padding: 5px 10px !important;
            }
            .hotCard + .hotCard {
              border-top: 1px solid rgba(79, 107, 145, 0.22) !important;
            }
            .hotBody {
              display: block !important;
              padding-right: 0 !important;
            }
            .hotFoot {
              margin-top: 14px !important;
              padding-top: 12px !important;
            }
            .pageFooterLinks {
              display: none !important;
            }
          `;
          document.head.appendChild(style);
        }
        """
    )
    first = None
    footer = None
    card_boxes = []
    for _ in range(240):
        first = page.locator(".hotCard").first.bounding_box()
        footer = page.locator(".pageFooter").bounding_box()
        cards = page.locator(".hotCard").all()
        card_boxes = [c.bounding_box() for c in cards]
        if first and footer and card_boxes and all(card_boxes):
            break
        page.wait_for_timeout(250)
    if not first or not footer or not card_boxes:
        raise RuntimeError("Could not resolve card/footer bounds.")

    with NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    page.screenshot(path=str(tmp_path), full_page=True, type="png", omit_background=True)
    doc_w = page.evaluate("document.documentElement.scrollWidth")

    try:
        img = Image.open(tmp_path).convert("RGBA")
        img_w, img_h = img.size
        scale = img_w / float(doc_w)

        x = int(round(footer["x"] * scale))
        y = int(round(first["y"] * scale))
        right = int(round((footer["x"] + footer["width"]) * scale))
        bottom = int(round((footer["y"] + footer["height"]) * scale))

        x = max(0, x)
        y = max(0, y)
        right = min(img_w, right)
        bottom = min(img_h, bottom)

        crop = img.crop((x, y, right, bottom)).convert("RGBA")
        pix = crop.load()
        cw, ch = crop.size

        # Keep card content as-is, clear only inter-card gaps to full transparency.
        ranges = []
        for bb in card_boxes:
            if not bb:
                continue
            cy1 = int(round((bb["y"] * scale) - y))
            cy2 = int(round(((bb["y"] + bb["height"]) * scale) - y))
            ranges.append((cy1, cy2))
        ranges.sort(key=lambda it: it[0])

        for i in range(len(ranges) - 1):
            gap_top = max(0, ranges[i][1])
            gap_bottom = min(ch, ranges[i + 1][0])
            if gap_bottom <= gap_top:
                continue
            for gy in range(gap_top, gap_bottom):
                for gx in range(cw):
                    r, g, b, _ = pix[gx, gy]
                    pix[gx, gy] = (r, g, b, 0)

        crop.save(out_path, format="PNG")
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


def run(
    html: Path,
    out_dir: Path,
    lang: str,
    thumb_name: str,
    body_name: str,
    min_cards: int,
    content_width: int | None,
    device_scale: float,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = out_dir / thumb_name
    body_path = out_dir / body_name
    url = build_url(html)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        viewport_width = max(1000, (content_width or 900) + 160)
        page = browser.new_page(viewport={"width": viewport_width, "height": 2400}, device_scale_factor=device_scale)
        page.add_init_script(
            f"""
            try {{
              localStorage.setItem('lang', '{lang}');
            }} catch (e) {{}}
            """
        )
        page.goto(url, wait_until="domcontentloaded", timeout=120000)
        apply_capture_width(page, content_width)
        ensure_cards(page, minimum=min_cards, timeout_ms=120000)
        force_language(page, lang=lang, min_cards=min_cards)
        page.wait_for_timeout(1800)

        export_thumbnail(page, thumb_path)
        export_body(page, body_path)

        browser.close()

    print(f"thumbnail={thumb_path}")
    print(f"body={body_path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export ai4 thumbnail/body PNG assets.")
    parser.add_argument("--html", default="ai4.html", help="Path to ai4 html file")
    parser.add_argument("--out-dir", default="output", help="Output directory")
    parser.add_argument("--lang", choices=["en", "ko"], default="en", help="Language view to capture")
    parser.add_argument("--thumb-name", default="ai4-thumbnail.png", help="Thumbnail output file name")
    parser.add_argument("--body-name", default="ai4-rank1-curated.png", help="Body output file name")
    parser.add_argument("--min-cards", type=int, default=10, help="Minimum rendered hot cards to wait for")
    parser.add_argument("--content-width", type=int, default=0, help="Override rendered content width in CSS pixels")
    parser.add_argument("--device-scale", type=float, default=2, help="Playwright device scale factor")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    html = Path(args.html)
    if not html.exists():
        raise FileNotFoundError(f"HTML file not found: {html}")
    run(
        html=html,
        out_dir=Path(args.out_dir),
        lang=args.lang,
        thumb_name=args.thumb_name,
        body_name=args.body_name,
        min_cards=max(1, args.min_cards),
        content_width=args.content_width if args.content_width > 0 else None,
        device_scale=max(0.5, args.device_scale),
    )


if __name__ == "__main__":
    main()
