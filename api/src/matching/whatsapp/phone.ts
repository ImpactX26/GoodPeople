/**
 * Sign-in stores 10-digit Indian numbers ("9876543210"); WhatsApp uses the
 * country code without "+" ("919876543210"). Convert only at the WhatsApp edge.
 */
export const toWhatsApp = (phone: string) => (phone.length === 10 ? `91${phone}` : phone);

export function fromWhatsApp(wa: string) {
  const digits = wa.replace(/\D/g, "");
  return digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
}
