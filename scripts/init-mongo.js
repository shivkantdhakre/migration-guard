// MongoDB Initialization Script
db = db.getSiblingDB('appdb');

db.createCollection('customers');
db.createCollection('orders');

db.customers.createIndex({ email: 1 }, { unique: false });
db.customers.createIndex({ "metadata.externalId": 1 });
db.orders.createIndex({ customerId: 1 });
db.orders.createIndex({ orderNumber: 1 });

print("MigrationGuard MongoDB source initialized successfully.");
