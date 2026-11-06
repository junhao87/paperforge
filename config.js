// Public, browser-safe Supabase configuration.
// Fill in your PROJECT URL and PUBLISHABLE/ANON key from Supabase Dashboard.
// NEVER put a service_role key, secret key, password, or private credential here.
export const PAPERFORGE_CONFIG = Object.freeze({
  supabaseUrl: '',
  supabaseAnonKey: '',
  adminEmail: 'junhaochong5@gmail.com',
  monthlyPrice: 10,
  currency: 'MYR',
  paymentQrImage: '', // e.g. './assets/payment-qr.png', after QR is supplied
});
