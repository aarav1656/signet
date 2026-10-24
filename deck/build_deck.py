"""Builds deck/Signet-Deck.pptx on the Open House Singapore template.

uv run --with python-pptx python deck/build_deck.py <template.pptx> <out.pptx>
"""
import copy
import sys

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

LIME = RGBColor(0xD4, 0xFF, 0x00)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
NAVY = RGBColor(0x00, 0x12, 0x5F)
BLACK = RGBColor(0, 0, 0)
HEAD = "Urbanist SemiBold"
BODY = "Urbanist Medium"
EXPLORER = "https://explorer.testnet.chain.robinhood.com/tx/"
TX_TRADE = "0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03"
TX_REFUSAL = "0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8"

tpl, out = sys.argv[1], sys.argv[2]
prs = Presentation(tpl)
orig_ids = list(prs.slides._sldIdLst)
slides_orig = list(prs.slides)
canvas_src = slides_orig[4]  # blank canvas slide
proto = slides_orig[2]  # slide with footer + number placeholders on layout BLANK_1_1_2
content_layout = proto.slide_layout


def run(p, text, size, color=WHITE, font=BODY, bold=False, link=None):
    r = p.add_run()
    r.text = text
    r.font.size = Pt(size)
    r.font.color.rgb = color
    r.font.name = font
    r.font.bold = bold
    if link:
        r.hyperlink.address = link
    return r


def fill_tf(tf, paras, anchor=MSO_ANCHOR.TOP, margins=0.1):
    """paras: list of dict(runs=[(text, kw)], align, space_after)"""
    for extra in list(tf.paragraphs)[1:]:
        extra._p.getparent().remove(extra._p)
    for r0 in list(tf.paragraphs[0].runs):
        r0._r.getparent().remove(r0._r)
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(margins)
    tf.margin_top = tf.margin_bottom = Inches(margins * 0.7)
    for i, spec in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = spec.get("align", PP_ALIGN.LEFT)
        p.space_after = Pt(spec.get("after", 0))
        p.space_before = Pt(0)
        if "line" in spec:
            p.line_spacing = spec["line"]
        for text, kw in spec["runs"]:
            run(p, text, **kw)


def P(text, size=14, color=WHITE, font=BODY, after=0, align=PP_ALIGN.LEFT, link=None, line=None):
    d = {"runs": [(text, dict(size=size, color=color, font=font, link=link))], "after": after, "align": align}
    if line:
        d["line"] = line
    return d


def PR(runs, after=0, align=PP_ALIGN.LEFT):
    return {"runs": runs, "after": after, "align": align}


def R(text, size=14, color=WHITE, font=BODY, link=None):
    return (text, dict(size=size, color=color, font=font, link=link))


def box(slide, x, y, w, h, paras=None, fill=NAVY, line=LIME, lw=1.5, anchor=MSO_ANCHOR.TOP, margins=0.12, shape=MSO_SHAPE.RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.shadow.inherit = False
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(lw)
    if paras:
        fill_tf(s.text_frame, paras, anchor, margins)
    return s


def text(slide, x, y, w, h, paras, anchor=MSO_ANCHOR.TOP, margins=0.05):
    t = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    fill_tf(t.text_frame, paras, anchor, margins)
    return t


def footnote(slide, s):
    text(slide, 0.3, 4.74, 9.4, 0.36, [P(s, 9, NAVY, HEAD)], anchor=MSO_ANCHOR.MIDDLE, margins=0.02)


def new_slide(title, size=28):
    s = prs.slides.add_slide(content_layout)
    for ph in list(s.placeholders):
        if ph.placeholder_format.idx != 0:
            ph._element.getparent().remove(ph._element)
    for sp in proto.shapes:
        if sp.is_placeholder and sp.placeholder_format.idx in (7, 12):
            s.shapes._spTree.append(copy.deepcopy(sp._element))
    t = s.shapes.title
    t.left, t.top, t.width, t.height = Inches(0.3), Inches(0.2), Inches(9.4), Inches(1.05)
    fill_tf(t.text_frame, [P(title, size, LIME, HEAD)], MSO_ANCHOR.MIDDLE, 0.05)
    return s


def notes(slide, s):
    slide.notes_slide.notes_text_frame.text = s


def to_back(slide, shape, pos=2):
    tree = slide.shapes._spTree
    tree.remove(shape._element)
    tree.insert(pos, shape._element)


def pic(slide, name, x, y, w=None, h=None):
    return slide.shapes.add_picture(name, Inches(x), Inches(y), Inches(w) if w else None, Inches(h) if h else None)


def stat(slide, x, y, w, h, big, label, bigsize=40, labsize=13):
    box(slide, x, y, w, h, [P(big, bigsize, LIME, HEAD, after=2), P(label, labsize, WHITE, BODY)], anchor=MSO_ANCHOR.MIDDLE)


# media extracted from the template for reuse
import io
import zipfile

zf = zipfile.ZipFile(tpl)
media = {n: io.BytesIO(zf.read(f"ppt/media/{n}")) for n in ("image5.png", "image6.png", "image7.png", "image10.png")}

# ---------------------------------------------------------------- 1 cover
s1 = new_slide("SIGNET", 96)
t = s1.shapes.title
t.left, t.top, t.width, t.height = Inches(0.55), Inches(1.0), Inches(6.2), Inches(1.7)
plate = box(s1, 0.4, 0.85, 6.5, 2.0, None, fill=BLACK, line=LIME, lw=3)
to_back(s1, plate)
fill_tf(t.text_frame, [P("SIGNET", 88, LIME, HEAD, align=PP_ALIGN.CENTER)], MSO_ANCHOR.MIDDLE, 0.05)
text(s1, 0.4, 3.05, 6.6, 1.1, [P("AI trading agents with a provable record and a private strategy", 26, WHITE, HEAD)])
text(s1, 0.4, 4.3, 6.8, 0.4, [P("On Robinhood Chain  |  Arbitrum Founder House Singapore", 14, NAVY, HEAD)])
pic(s1, media["image6.png"], 6.9, 0.35, 3.3, 3.3)
pic(s1, media["image5.png"], 7.0, 3.55, 2.6, 0.9)
notes(s1, "0:00 to 0:08. Signet puts AI trading agents on Robinhood Chain whose track record is provable and whose strategy stays private. A record belongs to the code that made it, and today nothing says which code that was.")

# ---------------------------------------------------------------- evidence helpers
from PIL import Image as _Image


def shot(slide, path, x, y, w=None, h=None, line=LIME, lw=1.25):
    """Adds a screenshot at the given width (or height), keeps its aspect, outlines it. Returns the placed height."""
    im = _Image.open(path)
    ar = im.width / im.height
    if w:
        h = w / ar
    else:
        w = h * ar
    p = pic(slide, path, x, y, w, h)
    p.line.color.rgb = line
    p.line.width = Pt(lw)
    return h


def tile_cap(slide, x, y, w, handle, what):
    text(slide, x, y, w, 0.26, [PR([R(handle, 11, LIME, HEAD), R("  " + what, 11, WHITE, BODY)])], anchor=MSO_ANCHOR.MIDDLE, margins=0.02)


# ---------------------------------------------------------------- A robinhood launch
s2 = new_slide("150,000+ customers have opened agentic trading accounts at Robinhood", 28)
shot(s2, "deck/img/x-robinhood-agents.png", 0.3, 1.4, w=3.2)
shot(s2, "deck/img/newsroom-head.png", 3.75, 1.4, w=5.95)
shot(s2, "deck/img/newsroom-150k.png", 3.75, 2.85, w=5.95)
box(s2, 3.75, 3.6, 5.95, 1.05, [
    PR([R("150,000+ ", 30, LIME, HEAD), R("agentic accounts since May", 15, WHITE, HEAD)], after=1),
    P("Agents use Robinhood's tools almost 30 million times a day. Robinhood Agents launched on 2026-09-29.", 12, WHITE, BODY),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.14)
footnote(s2, "Sources: x.com/RobinhoodApp/status/2105074572722679839 (2026-09-29, 389K views); Robinhood newsroom, HOOD Summit, robinhood.com/us/en/newsroom/hood-summit-2026/ (2026-09-29). Captured 2026-10-24.")

# ---------------------------------------------------------------- B no audit
s3 = new_slide("Robinhood does not control, supervise, monitor, recommend, or audit agents", 28)
shot(s3, "deck/img/newsroom-audit.png", 0.3, 1.4, w=9.4)
box(s3, 0.3, 3.55, 9.4, 1.1, [
    PR([R("Limits answer how much an agent can lose. ", 21, WHITE, HEAD), R("Nothing says which code is trading.", 21, LIME, HEAD)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.2)
footnote(s3, "Source: Robinhood newsroom, HOOD Summit, 2026-09-29, the agentic trading disclosure; the sentence is verbatim and highlighted. Captured 2026-10-24.")

# ---------------------------------------------------------------- C bot posts
s_c = new_slide("0 of 22 viral AI trading bot posts gave a wallet you could check", 28)
tiles = [
    ("metazet", "@Meta_ZET", "22 vetted, 0 with a wallet"),
    ("dee_fvg", "@dee_fvg", "$0.01 to $101K, a video"),
    ("goddyfx01", "@goddyfx01", "$9.91 to $158,890, a video"),
    ("solst1ne", "@SolSt1ne", "$38 to $8,740, a video"),
    ("whitman", "@WhitmanXAI", "$100 to $35K, a screenshot"),
    ("eastenray", "@EaStEnRaY1", "100% win rate, a video"),
]
TW, TH = 3.05, 3.05 * 400 / 956
for i, (key, handle, what) in enumerate(tiles):
    cx = 0.3 + (i % 3) * 3.175
    cy = 1.36 + (i // 3) * (TH + 0.36)
    shot(s_c, f"deck/img/tile-{key}.png", cx, cy, w=TW, line=LIME if i == 0 else WHITE, lw=3 if i == 0 else 1)
    tile_cap(s_c, cx, cy + TH + 0.03, TW, handle, what)
footnote(s_c, "Sources: each tile is the post itself on x.com, read 2026-10-24; the top left post is the 22-post vetting (x.com/Meta_ZET/status/2110788179754094667). The caption names the proof each post attaches. None of the six gives a wallet address or a transaction.")

# ---------------------------------------------------------------- architecture
s4 = new_slide("One measurement admitted, enforced on chain", 28)
s4.shapes.title.top, s4.shapes.title.height = Inches(0.2), Inches(0.75)
shot(s4, "deck/img/architecture.png", 0.35, 1.0, w=9.3)
footnote(s4, "Sources: contracts/src/AgentAccount.sol, contracts/deployments/46630.json, verifier/, receipt-verifier/, agent-cvm/deployments/2026-10-24.json. Diagram built with archify from deck/img/architecture.archify.json.")

# ---------------------------------------------------------------- the CVM is admitted
s_adm = new_slide("A real enclave, verified by Intel and admitted by the follower's account", 28)
shot(s_adm, "deck/img/phala-verified.png", 0.3, 1.4, w=6.6)
shot(s_adm, "deck/img/explorer-admit.png", 0.3, 3.05, w=6.6)
box(s_adm, 7.1, 1.4, 2.6, 1.32, [
    P("PHALA ATTESTATION EXPLORER", 10, LIME, HEAD, after=3),
    P("Quote verified. MRCONFIG holds the compose hash 9f997c38…2606, which pins the strategy hash.", 12, WHITE, BODY),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.12)
box(s_adm, 7.1, 3.05, 2.6, 1.45, [
    P("ADMITTING TRANSACTION", 10, LIME, HEAD, after=3),
    P("registerAgent succeeded on Robinhood Chain, block 141,688,284.", 12, WHITE, BODY, after=3),
    PR([R("tx 0x5fdc4acb…965c", 12, LIME, HEAD, link=EXPLORER + "0x5fdc4acb64d8f1dddc9042c9101c652f87f7483cc1163d0c878b431c44ce965c")]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.12)
footnote(s_adm, "Sources: proof.t16z.com/reports/36dc782d…c702 (quote from the CVM's /quote endpoint, 2026-10-24); agent-cvm/deployments/2026-10-24.json (composeHash); explorer.testnet.chain.robinhood.com, tx 0x5fdc4acb…965c.")

# ---------------------------------------------------------------- demo: trade
s5 = new_slide("One real trade: the receipt names the workload and the model", 28)
h5 = shot(s5, "deck/img/explorer-trade-logs.png", 0.3, 1.4, w=6.6)
box(s5, 0.3, 1.4 + h5 + 0.15, 6.6, 4.65 - (1.4 + h5 + 0.15), [
    PR([R("TradeExecuted ", 14, LIME, HEAD), R("carries the measurement the agent was admitted under and the model hash of its verified inference receipt.", 14, WHITE, BODY)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
box(s5, 7.1, 1.4, 2.6, 3.25, [
    P("ATTESTED TRADE", 11, LIME, HEAD, after=4),
    P("Bought TSLA with 1 USDG", 17, WHITE, HEAD, after=6),
    P("amountOut 0.00391 TSLA", 12, WHITE, BODY, after=4),
    P("success, 504,449 gas, block 127,188,951", 12, WHITE, BODY, after=8),
    PR([R("tx 0x0023f359…3b03", 13, LIME, HEAD, link=EXPLORER + TX_TRADE)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.14)
footnote(s5, "Source: explorer.testnet.chain.robinhood.com, Logs tab of tx 0x0023f359…3b03, chain 46630, captured 2026-10-24; highlighted rows are agentMeasurement and servedModelHash.")

# ---------------------------------------------------------------- demo: refusal
s_ref = new_slide("One real refusal: a genuine Intel quote from other code is reverted", 28)
h6 = shot(s_ref, "deck/img/explorer-refusal.png", 0.3, 1.4, w=6.6)
box(s_ref, 0.3, 1.4 + h6 + 0.15, 6.6, 4.65 - (1.4 + h6 + 0.15), [
    PR([R("The hardware is real and the code is not the approved code, ", 14, WHITE, BODY), R("so the account reverts.", 14, LIME, HEAD)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
box(s_ref, 7.1, 1.4, 2.6, 3.25, [
    P("REFUSED WORKLOAD", 11, LIME, HEAD, after=4),
    P("registerAgent reverts", 17, WHITE, HEAD, after=2),
    P("MeasurementNotApproved", 12, LIME, HEAD, after=6),
    P("failed, 2,349,054 gas, block 127,632,496", 12, WHITE, BODY, after=8),
    PR([R("tx 0xf98156ad…fcc8", 13, LIME, HEAD, link=EXPLORER + TX_REFUSAL)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.14)
footnote(s_ref, "Source: explorer.testnet.chain.robinhood.com, tx 0xf98156ad…fcc8, chain 46630, captured 2026-10-24 (status Failed, revert reason MeasurementNotApproved).")

# ---------------------------------------------------------------- live leaderboard
s5b = new_slide("The live app re-reads every trade from the chain", 28)
hl = shot(s5b, "deck/img/leaderboard-live.png", 0.3, 1.35, w=9.4)
y0 = 1.35 + hl + 0.2
stat(s5b, 0.3, y0, 3.0, 4.65 - y0, "3 of 3", "receipts re-read and verified", 28, 12)
stat(s5b, 3.5, y0, 3.0, 4.65 - y0, "1 strategy", "2 measurements, one compose hash", 28, 12)
box(s5b, 6.7, y0, 3.0, 4.65 - y0, [P("The return marks testnet fills to the mainnet Chainlink price. The receipts are the proof.", 12, WHITE, BODY)], anchor=MSO_ANCHOR.MIDDLE, margins=0.12)
footnote(s5b, "Source: signet-agents.vercel.app captured 2026-10-24, record read at block 141,782,630; Chainlink RHTSLA/USD 0x4A1166a6...7C38 on chain 4663.")

# ---------------------------------------------------------------- 6 innovation
s6 = new_slide("Private strategy, public proof")
inn = [
    ("Sealed", "Strategy hash in the measurement", "The measured compose pins the strategy's hash and the CVM boots only on a match. The text is sealed config. That CVM is admitted on 46630."),
    ("2.37M gas", "Intel's cert chain in one transaction", "A Stylus verifier in Rust walks the Intel certificate chain in the transaction that admits the key."),
    ("43 of 43", "Guard mutants killed in the TCB and QE checks", "The verifier crate checks Intel's signed TCB Info, QE Identity and revocation lists on collateral fetched from Intel PCS."),
]
for i, (big, h, b) in enumerate(inn):
    x = 0.3 + i * 3.2
    box(s6, x, 1.4, 3.0, 3.25, [P(big, 36, LIME, HEAD, after=2), P(h, 17, WHITE, HEAD, after=6), P(b, 14, WHITE, BODY)], margins=0.18)
footnote(s6, "Sources: 2,371,819 gas by cast estimate on chain 46630 (docs/ENGINEERING.md); verifier/MUTATIONS.md; strategy commitment: agent/src/strategy.ts, agent-cvm/deployments/2026-10-24.json, registerAgent tx 0x5fdc4acb...965c.")
notes(s6, "1:33 to 1:51. Three ideas. The measured compose commits to the strategy's hash, the CVM refuses to boot on any other strategy, and the text is sealed config: private strategy, public proof. A CVM built that way is admitted on the live account on Robinhood Chain testnet. The Stylus verifier walks Intel's certificate chain in Rust for about 2.37 million gas, inside the same transaction that admits the key. And the verifier checks the platform's TCB status, the quoting enclave identity and revocation lists, with 45 tests and every guard mutation killed.")

# ---------------------------------------------------------------- 7 contracts
s7 = new_slide("351 tests and 122 killed mutants guard the follower's account")
sx = [("351", "forge tests, 25 suites"), ("122 / 123", "AgentAccount guard mutants killed"), ("31 / 31", "Assay gate guards killed"), ("85", "Rust tests across both verifiers")]
for i, (b, l) in enumerate(sx):
    stat(s7, 0.3 + i * 2.38, 1.4, 2.28, 1.2, b, l, 30, 12)
box(s7, 0.3, 2.75, 4.6, 1.9, [
    P("ROLES", 13, LIME, HEAD, after=3),
    PR([R("Owner (follower): ", 13, WHITE, HEAD), R("approves a measurement, sets caps, pools and the model pin, pauses, revokes, withdraws. Two-step ownership.", 13)], after=3),
    PR([R("Agent key: ", 13, WHITE, HEAD), R("calls execute with a receipt. Can never become owner.", 13)], after=3),
    PR([R("Stylus verifiers: ", 13, WHITE, HEAD), R("admit the key, check the receipt.", 13)]),
], margins=0.14)
box(s7, 5.1, 2.75, 4.6, 1.9, [
    P("GUARDS ENFORCED IN THE SWAP", 13, LIME, HEAD, after=3),
    P("Per-trade cap, rolling 24-hour cap, owner approval above a threshold", 13, after=3),
    P("Canonical Uniswap v4 pools only, settled by balance delta", 13, after=3),
    P("ERC-8056 corporate-action guard; unapprove revokes in the same transaction", 13),
], margins=0.14)
footnote(s7, "forge test -j 1 on the integrated tree: 351 passed, 0 failed, 25 suites (docs/test-logs/forge-test-signet-2026-10-24.log). cargo test --release: verifier 67, receipt-verifier 18. docs/SECURITY.md, docs/security/agent-account-mutations.md.")
notes(s7, "1:51 to 2:03. The follower's account is the part that holds money, so it carries the tests. 351 forge tests across 25 suites, including invariants and fuzz tests. A mutation run removes 123 guards from the account one at a time and 122 are caught, the last one is documented as equivalent behavior. The Chiron gate has 31 of 31. The owner holds the powers, the agent key can never become owner, and the account swaps only through the canonical Uniswap v4 pool manager.")

# ---------------------------------------------------------------- 8 PMF
s8 = new_slide("Named creators already publish returns and keep the strategy sealed")
box(s8, 0.3, 1.4, 4.4, 1.5, [
    P("“If someone shows you a PnL, but not the thinking behind it, where's the credibility?”", 15, WHITE, HEAD, after=4),
    P("@KillaXBT, 239,232 followers, 2025-12-08", 11, LIME, HEAD),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
box(s8, 0.3, 3.05, 4.4, 1.6, [
    P("ARCANA", 13, LIME, HEAD, after=3),
    P("40 creators and 51 agents compete on Robinhood Chain. The leaderboard host we ask to add a measurement column.", 14, WHITE, BODY),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
rows = [
    ("@DeployFinance", "7,295", "$100,000 agent wallet, 70 days"),
    ("@GrowiHF", "1,592", "vault at +$2.94M all-time PnL, strategy undisclosed"),
    ("@HarmonicAgents", "2,502", "posts Stock Token pool volume"),
    ("@OxSimpleFarmer", "28,443", "Stock Token LP bots, 5-15% APY claimed"),
    ("@senpi_ai", "14,741", "114 strategy templates"),
]
paras = [P("FIRST TARGETS", 13, LIME, HEAD, after=4)]
for h, f, d in rows:
    paras.append(PR([R(h, 14, LIME, HEAD), R(f"  {f}", 12, WHITE, HEAD)]))
    paras.append(P(d, 13, WHITE, BODY, after=5))
box(s8, 4.9, 1.4, 4.8, 3.25, paras, margins=0.18)
footnote(s8, "Sources: gtm/USERS.md rows 1, 2, 3, 8, 10, 13 (followers per fxtwitter 2026-10-24; arcana-arena.com block 95,182,673; Hyperliquid vaultDetails 2026-10-24); quote gtm/signals.md row 2.")
notes(s8, "")

# ---------------------------------------------------------------- 9 business
s9 = new_slide("Creators earn on new profit. Followers pay for the code they approved.")
box(s9, 0.3, 1.4, 4.6, 1.85, [
    P("CREATOR PERFORMANCE FEE", 13, LIME, HEAD, after=3),
    P("A share of profit above the follower's high-water mark, so a creator is paid only for new profit.", 20, WHITE, HEAD),
], margins=0.18)
box(s9, 5.1, 1.4, 4.6, 1.85, [
    P("FOLLOWER SUBSCRIPTION", 13, LIME, HEAD, after=3),
    P("A flat monthly fee for an agent whose measurement the follower admitted.", 20, WHITE, HEAD),
], margins=0.18)
box(s9, 0.3, 3.4, 9.4, 1.25, [
    PR([R("Signet takes a share of each fee. ", 18, LIME, HEAD), R("The audience already sits in public-PnL venues: Hyperliquid lists 9,478 vaults and $405,600,393 of TVL, and none can say which code trades.", 17, WHITE, BODY)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.18)
footnote(s9, "Source: stats-data.hyperliquid.xyz/Mainnet/vaults, read 2026-10-24 (gtm/COMPETITORS.md section 2). Fee terms are the business model; the account enforces which code may trade.")
notes(s9, "2:15 to 2:23. The business model has two fees. Creators earn a performance fee on new profit above the follower's high-water mark. Followers pay a flat subscription for an admitted agent. Signet takes a share of each fee. Hyperliquid alone lists 9,478 vaults and over 405 million dollars of TVL, and none of them can say which code trades.")

# ---------------------------------------------------------------- 10 competition
s10 = new_slide("Others prove the number or the platform. Signet proves the workload.")
comp = [
    ("Product", "What it proves", "What it leaves open"),
    ("ARCANA", "Decisions were not edited after the fact", "Which code ran. The platform holds keys and prompts"),
    ("Hyperliquid vaults", "PnL and TVL, on chain", "Which code or model trades"),
    ("Robinhood Agents", "Limits and approvals on the account", "Which agent code is trading"),
    ("Knidos", "ZK proof that trades fit approved parameters", "Which model decided"),
    ("Automata DCAP", "TDX quotes verify on chain (~4M gas, per its README)", "No trading account and no trade bound to a measurement"),
    ("Phala agents", "A workload ran in a TDX VM", "Any account that refuses other code"),
    ("Signet", "The measurement and model behind every trade, enforced by the follower's account", "Prompt and strategy stay in the enclave"),
]
tbl_shape = s10.shapes.add_table(len(comp), 3, Inches(0.3), Inches(1.35), Inches(9.4), Inches(3.3))
tbl = tbl_shape.table
tblPr = tbl._tbl.tblPr
for a in ("firstRow", "bandRow"):
    tblPr.set(a, "0")
sid = tblPr.find(qn("a:tableStyleId"))
if sid is not None:
    tblPr.remove(sid)
for j, w in enumerate((1.9, 4.0, 3.5)):
    tbl.columns[j].width = Inches(w)
for i, row in enumerate(comp):
    tbl.rows[i].height = Inches(0.34 if i == 0 else 0.42)
    for j, val in enumerate(row):
        c = tbl.cell(i, j)
        c.fill.solid()
        c.fill.fore_color.rgb = LIME if i == 0 else (BLACK if i == len(comp) - 1 else NAVY)
        c.vertical_anchor = MSO_ANCHOR.MIDDLE
        c.margin_left = c.margin_right = Inches(0.1)
        c.margin_top = c.margin_bottom = Inches(0.03)
        tf = c.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        if i == 0:
            run(p, val, 13, NAVY, HEAD)
        elif j == 0:
            run(p, val, 14, LIME, HEAD)
        else:
            run(p, val, 12, WHITE, HEAD if i == len(comp) - 1 else BODY)
        tcPr = c._tc.get_or_add_tcPr()
        for edge in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
            ln = etree.SubElement(tcPr, qn(edge), w="12700")
            sf = etree.SubElement(ln, qn("a:solidFill"))
            etree.SubElement(sf, qn("a:srgbClr"), val="D4FF00")
        # borders must precede the fill in tcPr
        fills = [e for e in tcPr if e.tag in (qn("a:solidFill"),)]
        for f in fills:
            tcPr.remove(f)
            tcPr.append(f)
footnote(s10, "Sources: gtm/COMPETITORS.md (arcana-arena.com docs read 2026-10-24; Hyperliquid stats API; Robinhood newsroom 2026-09-29; knidos.xyz; Phala 2025 report); Automata: github.com/automata-network/automata-dcap-attestation README.")
notes(s10, "2:23 to 2:33. Where others stop. Arcana proves a record was not edited after the fact, but the platform holds the keys and the prompts. Hyperliquid vaults prove the PnL, not which code trades. Robinhood Agents gives limits and approvals and says it does not audit agents. Knidos proves trades fit approved parameters, not which model decided. Phala proves a workload ran in a TEE, and is not a trading product. Signet builds on Phala and proves the code behind every trade.")

# ---------------------------------------------------------------- 11 GTM
s11 = new_slide("Five named creators, one receipt, one message")
box(s11, 0.3, 1.4, 9.4, 0.8, [P("“Your next record can be a measurement, not a screenshot.”", 22, LIME, HEAD, align=PP_ALIGN.CENTER)], anchor=MSO_ANCHOR.MIDDLE)
box(s11, 0.3, 2.35, 3.0, 1.45, [P("FIRST AUDIENCE", 12, LIME, HEAD, after=2), P("40 creators and 51 agents on ARCANA's Season 2 US Equities board", 14)], margins=0.14)
box(s11, 3.5, 2.35, 3.0, 1.45, [P("THREE CHANNELS", 12, LIME, HEAD, after=2), P("Direct DMs with the TSLA receipt attached. Leaderboard hosts add a measurement column. Builder channels at Robinhood Chain, Arbitrum, Phala.", 12)], margins=0.14)
box(s11, 6.7, 2.35, 3.0, 1.45, [P("THE INTRO THAT HELPS", 12, LIME, HEAD, after=2), P("Gaetan Thabot, Robinhood Chain partnerships. Ben Greenberg, Arbitrum Foundation DevRel.", 13)], margins=0.14)
box(s11, 0.3, 3.95, 9.4, 0.7, [PR([R("Proof first: ", 14, LIME, HEAD), R("30 days of Stock Token trades from an outside creator, one measurement on every event.", 14)])], anchor=MSO_ANCHOR.MIDDLE, margins=0.14)
footnote(s11, "Sources: arcana-arena.com, 2026-10-24 01:13Z, block 95,182,673; names and titles per the Open House judge roster; deck/canvas.html GTM canvas.")
notes(s11, "2:33 to 2:42. Go to market starts with people we can name. Arcana's Season 2 board has 40 creators and 51 agents trading US equities on Robinhood Chain. We message them directly with the TSLA receipt attached, ask leaderboard hosts to add a measurement column, and work the Robinhood Chain, Arbitrum and Phala builder channels. The message is one sentence: your next record can be a measurement, not a screenshot.")

# ---------------------------------------------------------------- 12 ask + team
s12 = new_slide("The ask: introductions now, milestone funding to put five creators on chain")
box(s12, 0.3, 1.4, 4.0, 2.3, [
    P("THE ASK", 13, LIME, HEAD, after=3),
    P("One introduction to Robinhood Chain partnerships", 16, WHITE, HEAD, after=5),
    P("Five creators running agents in a TEE", 16, WHITE, HEAD, after=5),
    P("Milestone-based funding", 16, WHITE, HEAD),
], margins=0.16)
ms = [("Week 1", "First attested trades from the CVM whose compose pins the strategy hash"),
      ("Week 2", "Verifier with TCB, QE and revocation checks, tested on Intel PCS collateral, submitted for 46630"),
      ("Week 3", "Mainnet 4663 deployment from the runbook"),
      ("Week 4", "Five creators admitted, first trades naming one measurement each")]
paras = [P("30-DAY MILESTONES", 13, LIME, HEAD, after=4)]
for w, d in ms:
    paras.append(PR([R(w + "  ", 14, LIME, HEAD), R(d, 14)], after=4))
box(s12, 4.5, 1.4, 5.2, 2.3, paras, margins=0.16)
box(s12, 0.3, 3.85, 9.4, 0.8, [
    PR([R("Team: ", 15, LIME, HEAD), R("aarav1656 and pranjalcodesinw3, builders of every layer from the Stylus verifiers to the app.", 15)], after=3),
    PR([R("Check the TSLA trade yourself: ", 15, WHITE, HEAD), R("tx 0x0023f359…3b03 on the explorer", 15, LIME, HEAD, link=EXPLORER + TX_TRADE)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.16)
footnote(s12, "Sources: github.com/pranjalcodesinw3/chiron commit history; docs/mainnet-runbook.md; milestones follow the Proof You Need First box of the GTM canvas.")
notes(s12, "2:42 to 3:00. The ask is an introduction to Robinhood Chain partnerships and five creators willing to run their agent in an enclave. Funding releases half upfront and half on milestones: in week one the first attested trades come from the enclave whose compose pins the strategy hash, week two the platform checks are on chain, week three the mainnet deployment, week four five creators trading with a measurement on every event. A record you can verify, a strategy you keep. Open the transaction on the explorer and check the trade yourself.")

# ---------------------------------------------------------------- canvases
def clear_notes(sl, s):
    sl.notes_slide.notes_text_frame.text = s


def set_box(sh, title, body, tsize=13, bsize=10):
    tf = sh.text_frame
    tf.vertical_anchor = MSO_ANCHOR.TOP
    for p in list(tf.paragraphs)[1:]:
        p._p.getparent().remove(p._p)
    p0 = tf.paragraphs[0]
    for r in list(p0.runs):
        r._r.getparent().remove(r._r)
    run(p0, title, tsize, LIME, HEAD)
    for line in body:
        p = tf.add_paragraph()
        run(p, line, bsize, WHITE, BODY)


def fill_canvas(sl, header, boxes, sources, sourcesize=6.5):
    by_name = {sh.name: sh for sh in sl.shapes}
    ids = {n.split(";")[1]: sh for n, sh in by_name.items() if n.startswith("Google Shape;")}
    base = {k: v for k, v in ids.items()}
    first = min(int(k) for k in base if base[k].shape_type == 1)  # header autoshape id
    h = base[str(first)]
    tf = h.text_frame
    for p in list(tf.paragraphs)[1:]:
        p._p.getparent().remove(p._p)
    p0 = tf.paragraphs[0]
    for r in list(p0.runs):
        r._r.getparent().remove(r._r)
    run(p0, header[0], 15, LIME, HEAD)
    p1 = tf.add_paragraph()
    run(p1, header[1], 12, WHITE, BODY)
    for off, (title, body) in boxes.items():
        big = off >= 7
        set_box(base[str(first + off)], title, body, 13 if big else 12, 10.5 if big else 9)
    for sh in sl.shapes:
        if sh.is_placeholder and sh.has_text_frame and sh.text_frame.text.strip() in ("2025", "Arbitrum"):
            for r0 in sh.text_frame.paragraphs[0].runs:
                r0.text = ""
    tb = text(sl, 0.12, 4.88, 9.76, 0.24, [P(sources, sourcesize, WHITE, BODY)], margins=0.02)
    return base


# product canvas = template slide 5
product = canvas_src
gtm = prs.slides.add_slide(product.slide_layout)
for ph in list(gtm.shapes):
    ph._element.getparent().remove(ph._element)
for el in product.shapes._spTree:
    if el.tag in (qn("p:sp"), qn("p:pic"), qn("p:grpSp")):
        gtm.shapes._spTree.append(copy.deepcopy(el))

import json as _json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
CJ = _json.loads((ROOT / "deck/canvas/content.json").read_text())
PRODUCT_TITLES = ["Who is This For", "What They Do Today", "The Wedge", "Why Now", "Alternatives and Gaps", "Why Onchain, Why Arbitrum", "First 5-10 Users", "Ship This Weekend"]
GTM_TITLES = ["Who Buys, Who Uses", "First Reachable Audience", "3 Distribution Channels", "Core Message, One Sentence", "Proof You Need First", "The Intro That Helps", "5 Named Targets", "The Ask This Weekend"]
def canvas_boxes(key, titles):
    boxes = CJ[key]["boxes"]
    return {off: (titles[off - 1], [boxes[str(529 + off)]]) for off in range(1, 9)}

fill_canvas(
    product,
    tuple(CJ["product"]["header"]),
    canvas_boxes("product", PRODUCT_TITLES),
    "Sources: fxtwitter 2026-10-24 (posts, followers); cast receipt, chain 46630: txs 0x1f15df28...8134, 0xf98156ad...fcc8, 0x0023f359...3b03; Robinhood newsroom 2026-09-29; Morpho collateral post 2026-10-22, https://x.com/RobinhoodCrypto/status/2113270580472381515; arcana-arena.com block 95,182,673; Hyperliquid stats API 2026-10-24; Automata DCAP README.",
)
fill_canvas(
    gtm,
    tuple(CJ["gtm"]["header"]),
    canvas_boxes("gtm", GTM_TITLES),
    "Sources: arcana-arena.com 2026-10-24 01:13Z, block 95,182,673; @HarmonicAgents post 2026-10-23, followers per fxtwitter 2026-10-24; tx 0x0023f359...3b03 and 0xf98156ad...fcc8, chain 46630; names and titles per the Open House judge roster; @DeployFinance post 2026-10-23; @GrowiHF Hyperliquid vaultDetails 2026-10-24.",
)
clear_notes(product, "Canvas 1 of 2, the official Product Canvas for Signet. Who it is for, what they do today, the wedge, why now, alternatives, why onchain, first users, and what ships this weekend. Every figure carries its source in the line under the boxes.")
clear_notes(gtm, "Canvas 2 of 2, the official GTM Canvas for Signet. Who buys and who uses, the first reachable audience, three channels, the one-sentence message, the proof we need first, the intro that helps, five named targets, and the ask.")


# ---------------------------------------------------------------- 3-minute script (about 480 spoken words)
SCRIPT = [
    (s1, "0:00 to 0:08. Signet puts AI trading agents on Robinhood Chain with a provable record and a private strategy. A record belongs to the code behind it."),
    (s2, "0:08 to 0:16. Robinhood launched Robinhood Agents on September 29. Over 150,000 customers have opened agentic trading accounts, and agents use its tools almost 30 million times a day."),
    (s3, "0:16 to 0:25. In the same disclosure Robinhood says it does not control, supervise, monitor, recommend, or audit agents. Limits answer how much an agent can lose. Nothing says which code is trading."),
    (s_c, "0:25 to 0:35. The posts that sell these agents give nothing to check. Someone vetted 22 viral AI trading bot posts and zero gave a wallet you could check. These are six of the genre: a video, a screenshot, a referral link."),
    (s4, "0:35 to 0:52. Follow the flow. The creator's agent runs in an Intel TDX enclave and its quote carries the measurement and the compose hash that pins the strategy. A Stylus verifier on Robinhood Chain walks Intel's certificate chain in the transaction that admits the key. The follower's account stores that key only for a measurement the follower approved, then swaps through the canonical Uniswap v4 pool. Every trade emits a receipt that names the measurement and the model."),
    (s_adm, "0:52 to 1:00. This is the live enclave. Phala's explorer verifies its Intel quote, and the measurement config holds the compose hash that pins the strategy. The follower's account admitted it in this registerAgent transaction."),
    (s5, "1:00 to 1:11. The agent bought TSLA with one USDG on Robinhood Chain testnet. Open the Logs tab. The TradeExecuted event records the measurement the agent was admitted under and the model hash from its verified inference receipt."),
    (s_ref, "1:11 to 1:21. Now the refusal. A genuine Intel quote from a different workload was submitted. The hardware is real and the code is not the approved code, so the account reverts with MeasurementNotApproved after more than 2.3 million gas of verification."),
    (s5b, "1:21 to 1:30. The live app lists each strategy by its compose hash with every boot's measurement beside it, and re-reads each trade from the chain. The return marks testnet fills to the mainnet Chainlink price, so the number to trust is the receipts column."),
    (s6, "1:30 to 1:46. Three ideas. The measured compose pins the strategy's hash and the CVM boots only on a match, while the strategy text is sealed config. That is private strategy, public proof, and a CVM built that way is admitted on the live account. A Stylus verifier walks Intel's certificate chain for about 2.37 million gas. And the verifier crate checks platform status, enclave identity and revocation lists."),
    (s7, "1:46 to 1:57. The follower's account holds the money, so it carries the tests. 351 forge tests across 25 suites. A mutation run removes 123 guards one at a time and catches 122, the last is documented as equivalent. The agent key can never become owner."),
    (s8, "1:57 to 2:07. The first targets are named. DeployFinance gave an AI one hundred thousand dollars for 70 days. Growi runs a vault near three million dollars of profit with a strategy it will not open. Arcana hosts 40 creators on Robinhood Chain and is the leaderboard we ask to add a measurement column."),
    (s9, "2:07 to 2:14. The model has two fees. Creators earn a performance fee on new profit above the follower's high-water mark. Followers pay a flat subscription for an admitted agent. Signet takes a share of each fee."),
    (s10, "2:14 to 2:24. Arcana proves a record was not edited, but the platform holds keys and prompts. Hyperliquid proves the PnL, not the code. Robinhood gives limits. Knidos proves trades fit parameters. Automata verifies quotes on chain but has no trading account. Phala proves a workload ran in a TEE. Signet proves the measurement and model behind every trade."),
    (s11, "2:24 to 2:33. We start with people we can name. We message them with the TSLA receipt attached. One sentence: your next record can be a measurement, not a screenshot."),
    (s12, "2:33 to 2:52. The ask: an introduction to Robinhood Chain partnerships and five creators willing to run an agent in an enclave. Milestones across thirty days. A record you can verify, a strategy you keep. Open the transaction on the explorer and check the trade yourself."),
]
for sl, txt in SCRIPT:
    notes(sl, txt)

# ---------------------------------------------------------------- order, drop template slides
lst = prs.slides._sldIdLst
new_ids = [i for i in lst if i not in orig_ids]
canvas_id = orig_ids[4]
gtm_id = new_ids[-1]
main_ids = new_ids[:-1]
for sid_el in list(lst):
    lst.remove(sid_el)
for sid_el in main_ids + [canvas_id, gtm_id]:
    lst.append(sid_el)
for sid_el in orig_ids:
    if sid_el is not canvas_id:
        prs.part.drop_rel(sid_el.rId)
prs.save(out)
print("saved", out, len(prs.slides._sldIdLst), "slides")
