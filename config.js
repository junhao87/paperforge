// Public, browser-safe Supabase configuration.
// Supabase PROJECT URL and PUBLISHABLE key supplied by the PaperForge owner.
// NEVER put a service_role key, secret key, password, or private credential here.
export const PAPERFORGE_CONFIG = Object.freeze({
  supabaseUrl: 'https://ngsriedtuisaothoqhlk.supabase.co',
  supabaseAnonKey: 'sb_publishable_zmF8pRqRcFZGDUiTsu0YQg_-ezTGHCL',
  adminEmail: 'junhaochong5@gmail.com',
  monthlyPrice: 10,
  currency: 'MYR',
  paymentQrImage: './assets/duitnow-qr.png', // Touch 'n Go eWallet DuitNow QR provided by owner
});
