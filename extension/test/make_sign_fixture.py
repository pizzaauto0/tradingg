"""Erzeugt fixtures/sign.json: unsignierte Versioned Transaction + von solders signierte Referenz (Ed25519 ist deterministisch).
Aufruf aus dem Projektroot:  python extension/test/make_sign_fixture.py"""
import base64
import json
from pathlib import Path

from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

kp = Keypair()
ix = transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=Pubkey.new_unique(), lamports=12345))
msg = MessageV0.try_compile(kp.pubkey(), [ix], [], Hash.new_unique())
unsigned = VersionedTransaction.populate(msg, [Signature.default()])
signed = VersionedTransaction(msg, [kp])
other = Keypair()
foreign = VersionedTransaction.populate(
    MessageV0.try_compile(other.pubkey(), [transfer(TransferParams(from_pubkey=other.pubkey(), to_pubkey=kp.pubkey(), lamports=1))], [], Hash.new_unique()),
    [Signature.default()])
out = {"secret58": str(kp), "address": str(kp.pubkey()),
       "unsigned": base64.b64encode(bytes(unsigned)).decode(), "expectedSigned": base64.b64encode(bytes(signed)).decode(),
       "foreignUnsigned": base64.b64encode(bytes(foreign)).decode()}
d = Path(__file__).parent / "fixtures"
d.mkdir(exist_ok=True)
(d / "sign.json").write_text(json.dumps(out))
print("ok", out["address"])
