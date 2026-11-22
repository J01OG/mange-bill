-- =====================================================================
-- Sample data (optional). Run after the migrations to try the app.
-- Edit names and prices freely; you can also change them later in the app.
-- =====================================================================

update app_settings set
  farm_name    = 'Green Valley Mushroom Farm',
  address      = 'Village Road, Pune, Maharashtra',
  phone        = '+91 90000 00000',
  bill_footer  = 'Fresh from our farm. Thank you!';

insert into products (name, unit, price_paise, gst_rate_bp, hsn_code, sort_order) values
  ('Oyster mushroom 200 g',  'packet',  6000, 0, '0709', 1),
  ('Button mushroom 200 g',  'packet',  5000, 0, '0709', 2),
  ('Milky mushroom 250 g',   'packet',  7000, 0, '0709', 3),
  ('Oyster mushroom (loose)','kg',     24000, 0, '0709', 4),
  ('Shiitake 100 g',         'packet', 15000, 0, '0709', 5),
  ('Dried oyster 50 g',      'packet', 12000, 0, '0712', 6),
  ('Mushroom spawn bag',     'piece',  10000, 0, null,   7);

insert into workers (name, phone, pay_type, rate_paise, category) values
  ('Ramesh Pawar', '919800000001', 'daily',   50000,   'Harvest'),
  ('Sunita Jadhav','919800000002', 'daily',   45000,   'Packing'),
  ('Anil Shinde',  '919800000003', 'monthly', 1500000, 'Supervisor');

insert into coupons (code, description, kind, value, applies_to) values
  ('WELCOME10', '10% off for new customers', 'percent', 1000, 'all'),
  ('FLAT20',    'Rs 20 off',                 'flat',    2000, 'all');
