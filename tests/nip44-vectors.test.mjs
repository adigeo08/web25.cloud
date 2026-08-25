/**
 * NIP-44 v2 conformance.
 *
 * The vectors below are a subset of the reference suite published alongside
 * NIP-44 (github.com/paulmillr/nip44). They pin that Web25's implementation is
 * interoperable with every other Nostr client, and — just as importantly — that
 * it rejects the payloads the reference suite marks as invalid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { nostrCore } from '../src/nostr/nostr.js';

const VECTORS = {
    "get_conversation_key": [
        {
            "sec1": "315e59ff51cb9209768cf7da80791ddcaae56ac9775eb25b6dee1234bc5d2268",
            "pub2": "c2f9d9948dc8c7c38321e4b85c8558872eafa0641cd269db76848a6073e69133",
            "conversation_key": "3dfef0ce2a4d80a25e7a328accf73448ef67096f65f79588e358d9a0eb9013f1"
        },
        {
            "sec1": "a1e37752c9fdc1273be53f68c5f74be7c8905728e8de75800b94262f9497c86e",
            "pub2": "03bb7947065dde12ba991ea045132581d0954f042c84e06d8c00066e23c1a800",
            "conversation_key": "4d14f36e81b8452128da64fe6f1eae873baae2f444b02c950b90e43553f2178b"
        },
        {
            "sec1": "98a5902fd67518a0c900f0fb62158f278f94a21d6f9d33d30cd3091195500311",
            "pub2": "aae65c15f98e5e677b5050de82e3aba47a6fe49b3dab7863cf35d9478ba9f7d1",
            "conversation_key": "9c00b769d5f54d02bf175b7284a1cbd28b6911b06cda6666b2243561ac96bad7"
        },
        {
            "sec1": "86ae5ac8034eb2542ce23ec2f84375655dab7f836836bbd3c54cefe9fdc9c19f",
            "pub2": "59f90272378089d73f1339710c02e2be6db584e9cdbe86eed3578f0c67c23585",
            "conversation_key": "19f934aafd3324e8415299b64df42049afaa051c71c98d0aa10e1081f2e3e2ba"
        }
    ],
    "calc_padded_len": [
        [
            16,
            32
        ],
        [
            32,
            32
        ],
        [
            33,
            64
        ],
        [
            37,
            64
        ],
        [
            45,
            64
        ],
        [
            49,
            64
        ],
        [
            64,
            64
        ],
        [
            65,
            96
        ],
        [
            100,
            128
        ],
        [
            111,
            128
        ],
        [
            200,
            224
        ],
        [
            250,
            256
        ],
        [
            320,
            320
        ],
        [
            383,
            384
        ],
        [
            384,
            384
        ],
        [
            400,
            448
        ],
        [
            500,
            512
        ],
        [
            512,
            512
        ],
        [
            515,
            640
        ],
        [
            700,
            768
        ],
        [
            800,
            896
        ],
        [
            900,
            1024
        ],
        [
            1020,
            1024
        ],
        [
            65536,
            65536
        ]
    ],
    "encrypt_decrypt": [
        {
            "sec1": "0000000000000000000000000000000000000000000000000000000000000001",
            "sec2": "0000000000000000000000000000000000000000000000000000000000000002",
            "conversation_key": "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d",
            "nonce": "0000000000000000000000000000000000000000000000000000000000000001",
            "plaintext": "a",
            "payload": "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABee0G5VSK0/9YypIObAtDKfYEAjD35uVkHyB0F4DwrcNaCXlCWZKaArsGrY6M9wnuTMxWfp1RTN9Xga8no+kF5Vsb"
        },
        {
            "sec1": "0000000000000000000000000000000000000000000000000000000000000002",
            "sec2": "0000000000000000000000000000000000000000000000000000000000000001",
            "conversation_key": "c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d",
            "nonce": "f00000000000000000000000000000f00000000000000000000000000000000f",
            "plaintext": "\ud83c\udf55\ud83e\udec3",
            "payload": "AvAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAPSKSK6is9ngkX2+cSq85Th16oRTISAOfhStnixqZziKMDvB0QQzgFZdjLTPicCJaV8nDITO+QfaQ61+KbWQIOO2Yj"
        },
        {
            "sec1": "5c0c523f52a5b6fad39ed2403092df8cebc36318b39383bca6c00808626fab3a",
            "sec2": "4b22aa260e4acb7021e32f38a6cdf4b673c6a277755bfce287e370c924dc936d",
            "conversation_key": "3e2b52a63be47d34fe0a80e34e73d436d6963bc8f39827f327057a9986c20a45",
            "nonce": "b635236c42db20f021bb8d1cdff5ca75dd1a0cc72ea742ad750f33010b24f73b",
            "plaintext": "\u8868\u30dd\u3042A\u9dd7\u0152\u00e9\uff22\u900d\u00dc\u00df\u00aa\u0105\u00f1\u4e02\u3400\ud840\udc00",
            "payload": "ArY1I2xC2yDwIbuNHN/1ynXdGgzHLqdCrXUPMwELJPc7s7JqlCMJBAIIjfkpHReBPXeoMCyuClwgbT419jUWU1PwaNl4FEQYKCDKVJz+97Mp3K+Q2YGa77B6gpxB/lr1QgoqpDf7wDVrDmOqGoiPjWDqy8KzLueKDcm9BVP8xeTJIxs="
        },
        {
            "sec1": "8f40e50a84a7462e2b8d24c28898ef1f23359fff50d8c509e6fb7ce06e142f9c",
            "sec2": "b9b0a1e9cc20100c5faa3bbe2777303d25950616c4c6a3fa2e3e046f936ec2ba",
            "conversation_key": "d5a2f879123145a4b291d767428870f5a8d9e5007193321795b40183d4ab8c2b",
            "nonce": "b20989adc3ddc41cd2c435952c0d59a91315d8c5218d5040573fc3749543acaf",
            "plaintext": "ability\ud83e\udd1d\u7684 \u023a\u023e",
            "payload": "ArIJia3D3cQc0sQ1lSwNWakTFdjFIY1QQFc/w3SVQ6yvbG2S0x4Yu86QGwPTy7mP3961I1XqB6SFFTzqDZZavhxoWMj7mEVGMQIsh2RLWI5EYQaQDIePSnXPlzf7CIt+voTD"
        },
        {
            "sec1": "875adb475056aec0b4809bd2db9aa00cff53a649e7b59d8edcbf4e6330b0995c",
            "sec2": "9c05781112d5b0a2a7148a222e50e0bd891d6b60c5483f03456e982185944aae",
            "conversation_key": "3b15c977e20bfe4b8482991274635edd94f366595b1a3d2993515705ca3cedb8",
            "nonce": "8d4442713eb9d4791175cb040d98d6fc5be8864d6ec2f89cf0895a2b2b72d1b1",
            "plaintext": "pepper\ud83d\udc40\u0457\u0436\u0430\u043a",
            "payload": "Ao1EQnE+udR5EXXLBA2Y1vxb6IZNbsL4nPCJWisrctGxY3AduCS+jTUgAAnfvKafkmpy15+i9YMwCdccisRa8SvzW671T2JO4LFSPX31K4kYUKelSAdSPwe9NwO6LhOsnoJ+"
        }
    ],
    "invalid_decrypt": [
        {
            "note": "unknown encryption version",
            "conversation_key": "ca2527a037347b91bea0c8a30fc8d9600ffd81ec00038671e3a0f0cb0fc9f642",
            "payload": "#Atqupco0WyaOW2IGDKcshwxI9xO8HgD/P8Ddt46CbxDbrhdG8VmJdU0MIDf06CUvEvdnr1cp1fiMtlM/GrE92xAc1K5odTpCzUB+mjXgbaqtntBUbTToSUoT0ovrlPwzGjyp"
        },
        {
            "note": "unknown encryption version 0",
            "conversation_key": "36f04e558af246352dcf73b692fbd3646a2207bd8abd4b1cd26b234db84d9481",
            "payload": "AK1AjUvoYW3IS7C/BGRUoqEC7ayTfDUgnEPNeWTF/reBZFaha6EAIRueE9D1B1RuoiuFScC0Q94yjIuxZD3JStQtE8JMNacWFs9rlYP+ZydtHhRucp+lxfdvFlaGV/sQlqZz"
        },
        {
            "note": "invalid base64",
            "conversation_key": "ca2527a037347b91bea0c8a30fc8d9600ffd81ec00038671e3a0f0cb0fc9f642",
            "payload": "At\u0444upco0WyaOW2IGDKcshwxI9xO8HgD/P8Ddt46CbxDbrhdG8VmJZE0UICD06CUvEvdnr1cp1fiMtlM/GrE92xAc1EwsVCQEgWEu2gsHUVf4JAa3TpgkmFc3TWsax0v6n/Wq"
        },
        {
            "note": "invalid MAC",
            "conversation_key": "cff7bd6a3e29a450fd27f6c125d5edeb0987c475fd1e8d97591e0d4d8a89763c",
            "payload": "Agn/l3ULCEAS4V7LhGFM6IGA17jsDUaFCKhrbXDANholyySBfeh+EN8wNB9gaLlg4j6wdBYh+3oK+mnxWu3NKRbSvQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
            "note": "invalid MAC",
            "conversation_key": "cfcc9cf682dfb00b11357f65bdc45e29156b69db424d20b3596919074f5bf957",
            "payload": "AmWxSwuUmqp9UsQX63U7OQ6K1thLI69L7G2b+j4DoIr0oRWQ8avl4OLqWZiTJ10vIgKrNqjoaX+fNhE9RqmR5g0f6BtUg1ijFMz71MO1D4lQLQfW7+UHva8PGYgQ1QpHlKgR"
        },
        {
            "note": "invalid padding",
            "conversation_key": "5254827d29177622d40a7b67cad014fe7137700c3c523903ebbe3e1b74d40214",
            "payload": "Anq2XbuLvCuONcr7V0UxTh8FAyWoZNEdBHXvdbNmDZHB573MI7R7rrTYftpqmvUpahmBC2sngmI14/L0HjOZ7lWGJlzdh6luiOnGPc46cGxf08MRC4CIuxx3i2Lm0KqgJ7vA"
        },
        {
            "note": "invalid padding",
            "conversation_key": "fea39aca9aa8340c3a78ae1f0902aa7e726946e4efcd7783379df8096029c496",
            "payload": "An1Cg+O1TIhdav7ogfSOYvCj9dep4ctxzKtZSniCw5MwRrrPJFyAQYZh5VpjC2QYzny5LIQ9v9lhqmZR4WBYRNJ0ognHVNMwiFV1SHpvUFT8HHZN/m/QarflbvDHAtO6pY16"
        },
        {
            "note": "invalid padding",
            "conversation_key": "0c4cffb7a6f7e706ec94b2e879f1fc54ff8de38d8db87e11787694d5392d5b3f",
            "payload": "Am+f1yZnwnOs0jymZTcRpwhDRHTdnrFcPtsBzpqVdD6b2NZDaNm/TPkZGr75kbB6tCSoq7YRcbPiNfJXNch3Tf+o9+zZTMxwjgX/nm3yDKR2kHQMBhVleCB9uPuljl40AJ8kXRD0gjw+aYRJFUMK9gCETZAjjmrsCM+nGRZ1FfNsHr6Z"
        },
        {
            "note": "invalid payload length: 0",
            "conversation_key": "5cd2d13b9e355aeb2452afbd3786870dbeecb9d355b12cb0a3b6e9da5744cd35",
            "payload": ""
        },
        {
            "note": "invalid payload length: 4",
            "conversation_key": "d61d3f09c7dfe1c0be91af7109b60a7d9d498920c90cbba1e137320fdd938853",
            "payload": "Ag=="
        },
        {
            "note": "invalid payload length: 48",
            "conversation_key": "873bb0fc665eb950a8e7d5971965539f6ebd645c83c08cd6a85aafbad0f0bc47",
            "payload": "AqxgToSh3H7iLYRJjoWAM+vSv/Y1mgNlm6OWWjOYUClrFF8="
        },
        {
            "note": "invalid payload length: 92",
            "conversation_key": "9f2fef8f5401ac33f74641b568a7a30bb19409c76ffdc5eae2db6b39d2617fbe",
            "payload": "Ap/2SEZCVFIhYk6qx7nqJxM6TMI1ZoKmAzrO7vBDVJhhuZXWiM20i/tIsbjT0KxkJs2MZjh1oXNYMO9ggfk7i47WQA=="
        }
    ],
    "invalid_conversation_key": [
        {
            "sec1": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "pub2": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "note": "sec1 higher than curve.n"
        },
        {
            "sec1": "0000000000000000000000000000000000000000000000000000000000000000",
            "pub2": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "note": "sec1 is 0"
        },
        {
            "sec1": "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364139",
            "pub2": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "note": "pub2 is invalid, no sqrt, all-ff"
        },
        {
            "sec1": "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
            "pub2": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "note": "sec1 == curve.n"
        },
        {
            "sec1": "0000000000000000000000000000000000000000000000000000000000000002",
            "pub2": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "note": "pub2 is invalid, no sqrt"
        },
        {
            "sec1": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
            "pub2": "0000000000000000000000000000000000000000000000000000000000000000",
            "note": "pub2 is point of order 3 on twist"
        },
        {
            "sec1": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
            "pub2": "eb1f7200aecaa86682376fb1c13cd12b732221e774f553b0a0857f88fa20f86d",
            "note": "pub2 is point of order 13 on twist"
        },
        {
            "sec1": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
            "pub2": "709858a4c121e4a84eb59c0ded0261093c71e8ca29efeef21a6161c447bcaf9f",
            "note": "pub2 is point of order 3319 on twist"
        }
    ]
};

test('conversation keys match the NIP-44 reference vectors', () => {
    for (const vector of VECTORS.get_conversation_key) {
        assert.equal(
            nostrCore.bytesToHex(nostrCore.nip44ConversationKey(vector.sec1, vector.pub2)),
            vector.conversation_key
        );
    }
});

test('the padding schedule matches the NIP-44 reference vectors', () => {
    for (const [unpadded, padded] of VECTORS.calc_padded_len) {
        assert.equal(nostrCore.calcPaddedLength(unpadded), padded, `padded length for ${unpadded}`);
    }
});

test('encryption reproduces the reference payloads byte for byte', () => {
    for (const vector of VECTORS.encrypt_decrypt) {
        const conversationKey = nostrCore.nip44ConversationKey(vector.sec1, nostrCore.getNostrPublicKey(vector.sec2));
        assert.equal(nostrCore.bytesToHex(conversationKey), vector.conversation_key);
        assert.equal(nostrCore.nip44Encrypt(vector.plaintext, conversationKey, nostrCore.hexToBytes(vector.nonce)), vector.payload);
        assert.equal(nostrCore.nip44Decrypt(vector.payload, conversationKey), vector.plaintext);
    }
});

test('every payload the reference suite marks invalid is rejected', () => {
    for (const vector of VECTORS.invalid_decrypt) {
        assert.throws(
            () => nostrCore.nip44Decrypt(vector.payload, nostrCore.hexToBytes(vector.conversation_key)),
            `must reject: ${vector.note}`
        );
    }
});

test('invalid conversation-key inputs are rejected', () => {
    for (const vector of VECTORS.invalid_conversation_key) {
        assert.throws(() => nostrCore.nip44ConversationKey(vector.sec1, vector.pub2), `must reject: ${vector.note}`);
    }
});

test('plaintext outside the 1..65535 byte range is refused', () => {
    const conversationKey = nostrCore.hexToBytes('00'.repeat(32));
    assert.throws(() => nostrCore.nip44Encrypt('', conversationKey), /1–65535/);
    assert.throws(() => nostrCore.nip44Encrypt('a'.repeat(65536), conversationKey), /1–65535/);
});

test('a flipped ciphertext byte fails the MAC rather than decrypting', () => {
    const conversationKey = nostrCore.nip44ConversationKey(
        '1111111111111111111111111111111111111111111111111111111111111111',
        nostrCore.getNostrPublicKey('2222222222222222222222222222222222222222222222222222222222222222')
    );
    const payload = nostrCore.nip44Encrypt('hello', conversationKey);
    const bytes = nostrCore.base64ToBytes(payload);
    bytes[40] ^= 0xff;
    assert.throws(() => nostrCore.nip44Decrypt(nostrCore.bytesToBase64(bytes), conversationKey), /MAC/i);
});
