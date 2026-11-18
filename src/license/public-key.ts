/**
 * 授权文件的验证公钥（Ed25519，SPKI DER，base64）。对应的私钥只在开发者本机（~/.myrta-license/private.pem），
 * 由 scripts/license.ts 签发授权。换密钥后，之前签发的授权全部失效
 */
export const PUBLIC_KEY_DER_B64 = 'MCowBQYDK2VwAyEALcONqhaG7yT4ozNlLl0S74uF8q5KbwePLGaxuKaCueI=';
