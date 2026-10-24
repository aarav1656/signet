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

# ---------------------------------------------------------------- 2 problem
s2 = new_slide("0 of 22 viral AI trading bot posts gave a wallet you could check")
box(s2, 0.3, 1.4, 4.4, 3.2, [
    P("0 / 22", 80, LIME, HEAD, after=4, align=PP_ALIGN.CENTER),
    P("viral “my AI trading bot made 200x” posts that gave a wallet address to check. @Meta_ZET vetted all 22.", 15, WHITE, BODY, align=PP_ALIGN.CENTER),
], anchor=MSO_ANCHOR.MIDDLE)
box(s2, 4.9, 1.4, 4.8, 3.2, [
    P("“Until an agent can prove its track record without human intervention, it's just a cool demo.”", 24, WHITE, HEAD, after=10),
    P("@AndresLeo383120, 522 followers, 2026-07-14", 12, LIME, HEAD),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.25)
footnote(s2, "Source: gtm/signals.md rows 1 and 14, both re-read through api.fxtwitter.com on 2026-10-24; text verbatim, follower counts as of that read.")
notes(s2, "0:08 to 0:26. Someone vetted 22 viral posts claiming a 200x AI trading bot. Not one gave a wallet you could check. One reply says it plainly: until an agent can prove its track record without human intervention, it is a cool demo. Followers cannot tell which code is behind a record, and creators cannot open the strategy to prove it.")

# ---------------------------------------------------------------- 3 why it matters
s3 = new_slide("Robinhood opened accounts to 150,000+ agents. Nobody can check which code trades.")
stat(s3, 0.3, 1.4, 3.0, 1.5, "150,000+", "customers with agentic trading accounts", 40)
stat(s3, 3.5, 1.4, 3.0, 1.5, "~30M", "agent tool uses a day", 40)
box(s3, 6.7, 1.4, 3.0, 1.5, [P("“Robinhood does not control, supervise, monitor, recommend, or audit agents.”", 14, WHITE, HEAD)], anchor=MSO_ANCHOR.MIDDLE)
box(s3, 0.3, 3.05, 9.4, 1.6, [
    PR([R("The account answers how much an agent can lose. ", 18, WHITE, HEAD), R("It does not say which code is trading, or whether that code earned the record.", 18, LIME, HEAD)], after=8),
    P("Copy trading pays for screenshots: “Most copy trading platforms just show a fake leaderboard to get new users.” @Uchi_Yeager18", 14, WHITE, BODY),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.18)
footnote(s3, "Sources: Robinhood newsroom, HOOD Summit, 2026-09-29 (150,000+ agentic accounts, ~30M tool uses a day, audit statement); gtm/signals.md row 10, fxtwitter 2026-10-24.")
notes(s3, "0:26 to 0:41. Robinhood has over 150,000 agentic accounts and about 30 million tool uses a day. Its own page says Robinhood does not audit agents. The account answers how much can it lose. Which code is trading, and did that code earn the record, are open. Copy trading today pays for screenshots.")

# ---------------------------------------------------------------- 4 solution
s4 = new_slide("Three steps turn a track record into something you can check")
steps = [
    ("1", "The creator's agent runs in a TEE", "An Intel TDX confidential VM. The agent makes its trading key inside it. The strategy and prompts never leave."),
    ("2", "Every receipt names the code and the model", "TradeExecuted records the TDX measurement and the model hash. Stylus verifiers in Rust check both on chain."),
    ("3", "Followers admit only that code", "The follower's account stores the agent key only for a measurement they approved. A different workload is refused."),
]
for i, (n, h, b) in enumerate(steps):
    x = 0.3 + i * 3.2
    box(s4, x, 1.4, 3.0, 3.25, [P(h, 20, WHITE, HEAD, after=8), P(b, 15, WHITE, BODY)], margins=0.18).text_frame.margin_top = Inches(0.95)
    c = box(s4, x + 0.18, 1.55, 0.7, 0.7, [P(n, 30, NAVY, HEAD, align=PP_ALIGN.CENTER)], fill=LIME, line=None, anchor=MSO_ANCHOR.MIDDLE, margins=0.0, shape=MSO_SHAPE.OVAL)
footnote(s4, "Sources: README.md, docs/ENGINEERING.md, contracts/src/AgentAccount.sol. The measurement is Intel TDX's hash of the workload; the account checks it in the transaction that admits the key.")
notes(s4, "0:41 to 1:03. Three steps. One: the creator's agent runs in an Intel TDX enclave and makes its trading key inside it. Two: every trade's receipt names the measurement of the exact code and the hash of the model that answered, and Stylus verifiers written in Rust check both on chain. Three: the follower's account stores the agent key only if the follower approved that measurement. Any other workload is refused.")

# ---------------------------------------------------------------- 5 demo
s5 = new_slide("One real trade and one real refusal, both on chain")
box(s5, 0.3, 1.35, 4.6, 2.5, [
    P("ATTESTED TRADE", 13, LIME, HEAD, after=2),
    P("Bought TSLA with 1 USDG", 22, WHITE, HEAD, after=5),
    P("TradeExecuted names the workload measurement 0xeb2d9462… and the model hash 0xc8536dbf…", 16, WHITE, BODY, after=5),
    P("Status success, 504,449 gas", 16, WHITE, HEAD, after=5),
    PR([R("tx 0x0023f359…3b03, block 127,188,951", 14, LIME, HEAD, link=EXPLORER + TX_TRADE)]),
], margins=0.16)
box(s5, 5.1, 1.35, 4.6, 2.5, [
    P("REFUSED WORKLOAD", 13, LIME, HEAD, after=2),
    P("A different workload", 22, WHITE, HEAD, after=5),
    P("A genuine Intel quote from other code: registerAgent reverts MeasurementNotApproved", 16, WHITE, BODY, after=5),
    P("Status failed, 2,349,054 gas", 16, WHITE, HEAD, after=5),
    PR([R("tx 0xf98156ad…fcc8, block 127,632,496", 14, LIME, HEAD, link=EXPLORER + TX_REFUSAL)]),
], margins=0.16)
box(s5, 0.3, 3.95, 9.4, 0.72, [
    PR([R("What you see: ", 14, LIME, HEAD), R("open each link on the explorer. The trade's Logs tab shows the measurement and model hash. The refusal shows status failed. The app leaderboard lists each agent by measurement.", 14, WHITE, BODY)]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.14)
footnote(s5, "Sources: cast receipt on chain 46630 (rpc.testnet.chain.robinhood.com), 2026-10-24: trade status 1, gas 504,449; refusal status 0, gas 2,349,054. Explorer: explorer.testnet.chain.robinhood.com.")
notes(s5, "1:03 to 1:33. Here is the proof, on Robinhood Chain testnet. The agent bought TSLA with one USDG. Open the transaction, Logs tab: the event records the measurement of the workload and the hash of the model. Now the refusal. A genuine Intel TDX quote from a different workload, Phala's inference gateway, was submitted. The hardware is real and the code is not the one the owner approved, so the chain reverts with MeasurementNotApproved after more than 2.3 million gas of verification. In the app, the leaderboard lists each agent by its measurement. A new measurement is a new agent with an empty record.")

# ---------------------------------------------------------------- 6 innovation
s6 = new_slide("Private strategy, public proof")
inn = [
    ("Sealed", "Strategy hash in the measurement", "The measured compose commits to the strategy's hash. The strategy text stays in the enclave. Ships this weekend."),
    ("2.37M gas", "Intel's cert chain in one transaction", "A Stylus verifier in Rust walks the Intel certificate chain on chain, in the transaction that admits the key."),
    ("43 of 43", "TCB and QE identity checks", "The verifier checks Intel's signed TCB Info, QE Identity and revocation lists. Revoked never passes. 45 tests, 43 of 43 guard mutants killed."),
]
for i, (big, h, b) in enumerate(inn):
    x = 0.3 + i * 3.2
    box(s6, x, 1.4, 3.0, 3.25, [P(big, 36, LIME, HEAD, after=2), P(h, 17, WHITE, HEAD, after=6), P(b, 14, WHITE, BODY)], margins=0.18)
footnote(s6, "Sources: 2,371,819 gas by cast estimate on chain 46630 (docs/ENGINEERING.md); verifier/MUTATIONS.md, branch signet-contracts commit 960f010; strategy commitment, branch signet-strategy-commit commit 00e8cdf.")
notes(s6, "1:33 to 1:51. Three ideas. The measured image commits to the strategy's hash while the strategy text stays inside the enclave: private strategy, public proof. That ships this weekend. The Stylus verifier walks Intel's certificate chain in Rust for about 2.37 million gas, inside the same transaction that admits the key. And the verifier checks the platform's TCB status, the quoting enclave identity and revocation lists, with 45 tests and every guard mutation killed.")

# ---------------------------------------------------------------- 7 contracts
s7 = new_slide("314 tests and 109 killed mutants guard the follower's account")
sx = [("314", "forge tests, 21 suites"), ("109 / 110", "AgentAccount guard mutants killed"), ("31 / 31", "ChironGate guards killed"), ("40", "Rust tests across both verifiers")]
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
footnote(s7, "forge test --list on this branch: 314 tests, 21 suites, 2 invariant and 3 fuzz tests; 0 failed in docs/test-logs. cargo test --list: verifier 22, receipt-verifier 18. docs/SECURITY.md, docs/security/agent-account-mutations.md.")
notes(s7, "1:51 to 2:03. The follower's account is the part that holds money, so it carries the tests. 314 forge tests across 21 suites, including invariants and fuzz tests. A mutation run removes 110 guards from the account one at a time and 109 are caught, the last one is documented as equivalent behavior. The Chiron gate has 31 of 31. The owner holds the powers, the agent key can never become owner, and the account swaps only through the canonical Uniswap v4 pool manager.")

# ---------------------------------------------------------------- 8 PMF
s8 = new_slide("Five named creators already publish returns and keep the strategy sealed")
box(s8, 0.3, 1.4, 4.4, 1.5, [
    P("“If someone shows you a PnL, but not the thinking behind it, where's the credibility?”", 15, WHITE, HEAD, after=4),
    P("@KillaXBT, 239,232 followers, 2025-12-08", 11, LIME, HEAD),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
box(s8, 0.3, 3.05, 4.4, 1.6, [
    P("“Track records are easy to verify onchain. The hard part is proving the agent didn't just overfit its model to last month's volatility.”", 14, WHITE, HEAD, after=4),
    P("@CoderJunkie, 13,373 followers, 2026-10-22", 11, LIME, HEAD),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.15)
rows = [
    ("@DeployFinance", "7,285", "$100,000 agent wallet, 70 days"),
    ("@GrowiHF", "1,592", "vault at +$2.94M all-time PnL, strategy undisclosed"),
    ("@Arcana_Arena", "236", "40 creators, 51 agents on Robinhood Chain"),
    ("@HarmonicAgents", "2,502", "posts Stock Token pool volume"),
    ("@senpi_ai", "14,741", "114 strategy templates"),
]
paras = [P("FIRST CREATORS", 13, LIME, HEAD, after=4)]
for h, f, d in rows:
    paras.append(PR([R(h, 14, LIME, HEAD), R(f"  {f}", 12, WHITE, HEAD)]))
    paras.append(P(d, 13, WHITE, BODY, after=5))
box(s8, 4.9, 1.4, 4.8, 3.25, paras, margins=0.18)
footnote(s8, "Sources: gtm/USERS.md rows 1, 2, 3, 8, 10 (followers per fxtwitter 2026-10-24; arcana-arena.com block 95,182,673; Hyperliquid vaultDetails 2026-10-24); quotes gtm/signals.md rows 2 and 15.")
notes(s8, "2:03 to 2:15. The first five users are named and public. DeployFinance gave an AI one hundred thousand dollars to trade for 70 days. Growi runs a Hyperliquid vault with nearly three million dollars of profit and a strategy it will not open. Arcana hosts 40 creators competing on Robinhood Chain right now. They already publish returns and keep the strategy private, which is exactly the pair Signet binds.")

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
s10 = new_slide("Others prove the number or the platform. Signet proves the code.")
comp = [
    ("Product", "What it proves", "What it leaves open"),
    ("ARCANA", "Decisions were not edited after the fact (Merkle roots on chain)", "Which code ran. The platform holds keys and prompts"),
    ("Hyperliquid vaults", "PnL and TVL, on chain", "Which code or model trades"),
    ("Robinhood Agents", "Limits and approvals on the account", "Which agent code is trading"),
    ("Knidos", "ZK proof that trades fit approved exchanges and parameters", "Which model decided. Testnet"),
    ("Phala agents", "A workload ran in a TDX VM with a measurement", "That it trades, and any account that refuses other code"),
    ("Signet", "The code and model behind every trade, enforced by the follower's account", "Prompt and strategy stay in the enclave"),
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
    tbl.rows[i].height = Inches(0.36 if i == 0 else 0.49)
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
footnote(s10, "Sources: gtm/COMPETITORS.md (arcana-arena.com docs read 2026-10-24; Hyperliquid stats API; Robinhood newsroom 2026-09-29; knidos.xyz; Phala 2025 report).")
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
    P("Funding released 50% upfront, 50% on the milestones", 16, WHITE, HEAD),
], margins=0.16)
ms = [("Week 1", "Strategy hash pinned in the measured image on the live CVM"),
      ("Week 2", "TCB and QE identity checks on the verifier deployed to 46630"),
      ("Week 3", "Mainnet 4663 deployment from the runbook"),
      ("Week 4", "Five creators admitted, first trades naming one measurement each")]
paras = [P("30-DAY MILESTONES", 13, LIME, HEAD, after=4)]
for w, d in ms:
    paras.append(PR([R(w + "  ", 14, LIME, HEAD), R(d, 14)], after=4))
box(s12, 4.5, 1.4, 5.2, 2.3, paras, margins=0.16)
box(s12, 0.3, 3.85, 9.4, 0.8, [
    PR([R("Team: ", 15, LIME, HEAD), R("aarav1656 and pranjalcodesinw3, builders of every layer from the Stylus verifiers to the app.", 15)], after=3),
    PR([R("Check the TSLA trade yourself: ", 15, WHITE, HEAD), R("chiron-receipts.vercel.app", 15, LIME, HEAD, link="https://chiron-receipts.vercel.app")]),
], anchor=MSO_ANCHOR.MIDDLE, margins=0.16)
footnote(s12, "Sources: github.com/pranjalcodesinw3/chiron commit history; docs/mainnet-runbook.md; milestones follow the Proof You Need First box of the GTM canvas.")
notes(s12, "2:42 to 3:00. The ask is an introduction to Robinhood Chain partnerships and five creators willing to run their agent in an enclave. Funding releases half upfront and half on milestones: in week one the strategy hash is pinned in the measured image on the live enclave, week two the platform checks are on chain, week three the mainnet deployment, week four five creators trading with a measurement on every event. A record you can verify, a strategy you keep. Open the app and check the trade yourself.")

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
        set_box(base[str(first + off)], title, body, 14 if big else 13, 12 if big else 10)
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

fill_canvas(
    product,
    ("Signet", "One line: AI trading agents whose track record is provable and whose strategy stays private."),
    {
        1: ("Who is This For", ["The operator behind @DeployFinance, who gave an AI agent $100,000 for 70 days and posted the result. Their followers pick which agent holds Stock Tokens."]),
        2: ("What They Do Today", ["“I don't mind showing my Polymarket PnL.. i do mind showing every single bet” (@Al_Nadim_nabil). They post a screenshot: 0 of 22 viral bot posts gave a wallet to check."]),
        3: ("The Wedge", ["Stock Token bot operators on Robinhood Chain. Their next record is a measurement, not a screenshot: each trade names the Intel TDX measurement and model that made it."]),
        4: ("Why Now", ["Robinhood has 150,000+ agentic accounts and does not audit agents. Stock Tokens became Morpho collateral on Oct 22. Phala runs 2,529 TEE workloads."]),
        5: ("Alternatives and Gaps", ["ARCANA: 51 agents, the platform holds keys and prompts. Hyperliquid: 9,478 vaults, no proof of which code trades. Knidos: testnet, proves rules, not the model."]),
        6: ("Why Onchain, Why Arbitrum", ["A Stylus verifier in Rust walks Intel's cert chain in one tx: 2.37M gas. Robinhood Chain Stock Tokens settle a TSLA trade for 1 USDG. Receipts on chain name the code."]),
        7: ("First 5-10 Users", ["@Arcana_Arena (40 creators), @HarmonicAgents (2,502), Meridian402 (market maker), @DeployFinance (7,285), @GrowiHF (+$2.94M PnL), @senpi_ai (14,741), @betashop (22,573), @the_nof1 (54,390), @OxSimpleFarmer (28,443), @Agent_Minimum (471)."]),
        8: ("Ship This Weekend", ["The measured image commits to the strategy's hash; the strategy text stays inside the enclave. The decision loop moves into the enclave. Five creator DMs with the TSLA receipt and verify_receipt."]),
    },
    "Sources: fxtwitter 2026-10-24 (posts, followers); tx 0x0023f359...3b03, chain 46630; Robinhood newsroom 2026-09-29; Morpho launch 2026-10-22; Phala 2025 report; arcana-arena.com block 95,182,673; Hyperliquid stats API 2026-10-24; cast estimate 2,371,819 gas.",
)
fill_canvas(
    gtm,
    ("Signet", "One line: Creators prove a record without opening the strategy. Followers fund only the code they approved."),
    {
        1: ("Who Buys, Who Uses", ["Uses: creators supply strategies and earn a performance fee on new profit. Buys: followers subscribe for an admitted agent and approve one hash. Signet takes a share of each fee."]),
        2: ("First Reachable Audience", ["40 creators and 51 agents on ARCANA's Season 2 US Equities board, plus operators who already post Stock Token volume in public."]),
        3: ("3 Distribution Channels", ["Direct DMs to Stock Token operators, TSLA receipt attached. Leaderboard hosts add a measurement column. Robinhood Chain, Arbitrum and Phala builder channels."]),
        4: ("Core Message, One Sentence", ["Your next record can be a measurement, not a screenshot. The measured image commits to the strategy's hash; the text stays inside the enclave."]),
        5: ("Proof You Need First", ["30 days of Stock Token trades from an outside creator, one measurement on every event. Today: one attested TSLA trade and one refusal on chain."]),
        6: ("The Intro That Helps", ["Gaetan Thabot, Director of Crypto Partnerships, Robinhood Chain. Ben Greenberg, DevRel, Arbitrum Foundation."]),
        7: ("5 Named Targets", ["@Arcana_Arena (40 creators), @HarmonicAgents (2,502), Meridian402 (tokenized stocks), @DeployFinance (7,285), @GrowiHF (1,592)."]),
        8: ("The Ask This Weekend", ["One introduction to Robinhood Chain partnerships. Five creators to run their agent in a TEE. Verify the TSLA trade yourself: chiron-receipts.vercel.app"]),
    },
    "Sources: arcana-arena.com 2026-10-24 01:13Z, block 95,182,673; @HarmonicAgents post 2026-10-23, followers per fxtwitter 2026-10-24; tx 0x0023f359...3b03 and 0xf98156ad...fcc8, chain 46630; names and titles per the Open House judge roster; @DeployFinance post 2026-10-23; @GrowiHF Hyperliquid vaultDetails 2026-10-24.",
)
clear_notes(product, "Canvas 1 of 2, the official Product Canvas for Signet. Who it is for, what they do today, the wedge, why now, alternatives, why onchain, first users, and what ships this weekend. Every figure carries its source in the line under the boxes.")
clear_notes(gtm, "Canvas 2 of 2, the official GTM Canvas for Signet. Who buys and who uses, the first reachable audience, three channels, the one-sentence message, the proof we need first, the intro that helps, five named targets, and the ask.")


# ---------------------------------------------------------------- 3-minute script (about 480 spoken words)
SCRIPT = [
    (s1, "0:00 to 0:08. Signet puts AI trading agents on Robinhood Chain with a provable record and a private strategy. A record belongs to the code that made it."),
    (s2, "0:08 to 0:26. Someone vetted 22 viral posts claiming a 200x AI trading bot. Zero gave a wallet you could check. One reply says it plainly: until an agent can prove its track record without human intervention, it is a cool demo."),
    (s3, "0:26 to 0:41. Robinhood has over 150,000 agentic accounts and about 30 million tool uses a day, and says it does not audit agents. Limits answer how much an agent can lose. Nothing answers which code is trading. Copy trading today pays for screenshots."),
    (s4, "0:41 to 1:03. Three steps. The creator's agent runs in an Intel TDX enclave and makes its key inside. Every receipt names the exact code and the model that answered, checked on chain by Stylus verifiers in Rust. The follower's account stores the agent key only for a measurement the follower approved. Any other workload is refused."),
    (s5, "1:03 to 1:33. Here is the proof on Robinhood Chain testnet. The agent bought TSLA with one USDG. Open the transaction, Logs tab: the event records the workload's measurement and the model hash. Now the refusal. A genuine Intel quote from a different workload was submitted. The hardware is real and the code is not the approved code, so the chain reverts with MeasurementNotApproved. In the app, the leaderboard lists each agent by measurement."),
    (s6, "1:33 to 1:51. Three ideas. The measured image commits to the strategy's hash while the strategy text stays in the enclave. That is private strategy, public proof, and it ships this weekend. A Stylus verifier walks Intel's certificate chain for about 2.37 million gas. And it checks platform status, enclave identity and revocation lists."),
    (s7, "1:51 to 2:03. The follower's account holds the money, so it carries the tests. 314 forge tests across 21 suites. A mutation run removes 110 guards one at a time and catches 109, the last is documented as equivalent. The agent key can never become owner."),
    (s8, "2:03 to 2:15. The first five users are named. DeployFinance gave an AI one hundred thousand dollars for 70 days. Growi runs a vault near three million dollars of profit with a strategy it will not open. Arcana hosts 40 creators on Robinhood Chain today."),
    (s9, "2:15 to 2:23. The model has two fees. Creators earn a performance fee on new profit above the follower's high-water mark. Followers pay a flat subscription for an admitted agent. Signet takes a share of each fee."),
    (s10, "2:23 to 2:33. Arcana proves a record was not edited, but the platform holds keys and prompts. Hyperliquid proves the PnL, not the code. Robinhood gives limits. Knidos proves trades fit parameters. Phala proves a workload ran in a TEE. Signet proves the code behind every trade."),
    (s11, "2:33 to 2:42. We start with people we can name. Arcana's board has 40 creators and 51 agents. We message them with the TSLA receipt attached. One sentence: your next record can be a measurement, not a screenshot."),
    (s12, "2:42 to 3:00. The ask: an introduction to Robinhood Chain partnerships and five creators willing to run an agent in an enclave. Funding releases half upfront and half on milestones across thirty days. A record you can verify, a strategy you keep. Open the app and check the trade yourself."),
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
