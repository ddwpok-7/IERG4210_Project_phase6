const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const sanitizeHtml = require('sanitize-html');
const csurf = require('csurf');
const crypto = require('crypto');
const fetch = require('node-fetch'); 
const {
    ApiError,
    CheckoutPaymentIntent,
    Client,
    Environment,
    LogLevel,
    OrdersController,
} = require('@paypal/paypal-server-sdk');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const ModelClient = require("@azure-rest/ai-inference").default;
const { AzureKeyCredential } = require("@azure/core-auth");

const app = express();
const port = 3000;

const processedTransactions = new Set();

const origin = 'http://localhost:3001';

const AZURE_ENDPOINT = "https://ierg4350lab7ai5677112965.services.ai.azure.com/models"
const AZURE_API_KEY  = "84k043jEuXbGe7mYr44lJRUXZxN1J88QnboJ2T0FX4eV9ah7p7kbJQQJ99BCACHYHv6XJ3w3AAAAACOGwqjo"
const AZURE_MODEL_NAME = "DeepSeek-R1"

const client = new ModelClient(AZURE_ENDPOINT, new AzureKeyCredential(AZURE_API_KEY));

app.use(cors({
    origin: origin,
    credentials: true,
}));
console.log(`CORS configured for origin: ${origin} with credentials`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.paypal.com https://www.sandbox.paypal.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-src 'self' https://www.paypal.com https://www.sandbox.paypal.com; connect-src 'self' http://localhost:3000 https://api-m.sandbox.paypal.com"
    );
    next();
});

const csrfProtection = csurf({ cookie: { httpOnly: true, secure: false, sameSite: 'Strict' } });

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BUSINESS_EMAIL } = process.env;
console.log('PAYPAL_CLIENT_ID loaded:', PAYPAL_CLIENT_ID ? PAYPAL_CLIENT_ID : 'No');

const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID,
    oAuthClientSecret: PAYPAL_CLIENT_SECRET,
  },
  timeout: 0,
  environment: Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: {
      logBody: true,
    },
    logResponse: {
      logHeaders: true,
    },
  },
});

const ordersController = new OrdersController(paypalClient);

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Aa246810@',
    database: 'ierg4210'
});

db.connect(err => {
    if (err) {
        console.error('Database connection failed:', err.stack);
        return;
    }
    console.log('Connected to database.');
});

const uploadpath = path.join(__dirname, '../html/uploads');
const storage = multer.diskStorage({
    destination: uploadpath,
    filename: (req, file, cb) => {
        cb(null, Date.now() + file.originalname);
    },
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Images only (jpg, png, gif)!'));
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 }, 
});

app.use('/static', express.static(path.join(__dirname, '../html')));
app.use('/uploads', express.static(uploadpath));

app.get('/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

function checkAdmin(req,res,next){
    const sessionToken = req.cookies.authToken;
    db.query('SELECT is_admin FROM users WHERE session_token = ?', [sessionToken],
        (err, results)=>{
            console.log(results);
            if (err || results.length === 0) {
                return ;
            }
            if (results[0].is_admin===1){
                next();
            } else {
                res.redirect('/');
                return;
            }
        }
    );
}

const authenticate = (req, res, next) => {
    const token = req.cookies.authToken;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
  
    db.query('SELECT * FROM users WHERE session_token = ?', [token], (err, results) => {
      if (err || results.length === 0) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      req.user = results[0];
      next();
    });
};

// Payment

const createOrder = async (cart) => {
  const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0).toFixed(2);

  const collect = {
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          amount: {
            currencyCode: "HKD",
            value: totalAmount,
          },
        },
      ],
    },
    prefer: "return=minimal",
  };

  try {
    const { body, ...httpResponse } = await ordersController.createOrder(collect);
    return {
      jsonResponse: JSON.parse(body),
      httpStatusCode: httpResponse.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(error.message);
    }
    throw error;
  }
};

const captureOrder = async (orderID) => {
  const collect = {
    id: orderID,
    prefer: "return=minimal",
  };

  try {
    const { body, ...httpResponse } = await ordersController.captureOrder(collect);
    return {
      jsonResponse: JSON.parse(body),
      httpStatusCode: httpResponse.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw new Error(error.message);
    }
    throw error;
  }
};


app.post('/api/paypal-webhook', express.raw({ type: 'application/x-www-form-urlencoded' }), async (req, res) => {
    try {
        res.status(200).send('OK');

        const ipnMessage = req.body;
        console.log('IPN received:', ipnMessage);

        const ipnVerifyUrl = 'https://www.sandbox.paypal.com/cgi-bin/webscr';
        const ipnBody = 'cmd=_notify-validate&' + new URLSearchParams(ipnMessage).toString();
        const verifyResponse = await fetch(ipnVerifyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: ipnBody,
        });
        const verifyResult = await verifyResponse.text();

        if (verifyResult !== 'VERIFIED') {
            console.error('IPN verification failed:', verifyResult);
            return;
        }
        console.log('IPN verified successfully');

        if (ipnMessage.payment_status !== 'Completed') {
            console.log(`Ignoring IPN with payment_status: ${ipnMessage.payment_status}`);
            return;
        }

        const transactionId = ipnMessage.txn_id;
        const orderID = ipnMessage.invoice;
        const receivedDigest = ipnMessage.custom;

        if (processedTransactions.has(transactionId)) {
            console.log(`Transaction ${transactionId} already processed`);
            return;
        }

        const [orderRows] = await db.promise().query('SELECT * FROM orders WHERE order_id = ?', [orderID]);
        if (!orderRows.length) {
            console.error(`Order ${orderID} not found in database`);
            return;
        }
        const order = orderRows[0];
        const { currency, merchant_email, salt, cart, total_price, digest } = order;

        const totalPriceNum = parseFloat(total_price);
        if (isNaN(totalPriceNum)) {
            console.error(`Invalid total_price for order ${orderID}: ${total_price}`);
            return;
        }

        const enrichedCart = JSON.parse(cart);
        const cartDetails = enrichedCart.map(item => `${item.pid}:${item.quantity}:${item.price}`).join('|');
        const digestInput = `${currency}|${merchant_email}|${salt}|${cartDetails}|${totalPriceNum.toFixed(2)}`;
        const calculatedDigest = crypto.createHash('sha256').update(digestInput).digest('hex');

        if (calculatedDigest !== receivedDigest) {
            console.error('Digest validation failed for order:', orderID);
            return;
        }
        console.log('Digest validated successfully');

        await db.promise().query(
            'UPDATE orders SET transaction_id = ?, status = ? WHERE order_id = ?',
            [transactionId, 'completed', orderID] 
        );
        console.log(`Order ${orderID} updated with transaction ${transactionId} and status completed`);

        processedTransactions.add(transactionId);
    } catch (error) {
        console.error('Error processing IPN:', error);
    }
});

app.post('/api/validate-cart', csrfProtection, async (req, res) => {
    try {
        const { cart } = req.body;
        if (!cart || !Array.isArray(cart) || cart.length === 0) {
            return res.status(400).json({ error: 'Invalid cart data' });
        }

        const enrichedCart = [];
        let totalPrice = 0;
        for (const item of cart) {
            const pid = parseInt(item.pid, 10);
            const quantity = parseInt(item.quantity, 10);
            if (isNaN(pid) || isNaN(quantity) || quantity <= 0) {
                return res.status(400).json({ error: `Invalid pid or quantity for item: ${JSON.stringify(item)}` });
            }
            const [product] = await db.promise().query('SELECT pid, name, price FROM products WHERE pid = ?', [pid]);
            if (!product.length) {
                return res.status(400).json({ error: `Product not found for pid: ${pid}` });
            }
            const price = parseFloat(product[0].price);
            enrichedCart.push({ pid: pid.toString(), quantity, price, name: product[0].name });
            totalPrice += price * quantity;
        }

        const token = req.cookies.authToken;
        let username = 'guest';
        if (token) {
            const [user] = await db.promise().query('SELECT email FROM users WHERE session_token = ?', [token]);
            if (user.length) {
                username = user[0].email;
            }
        }

        const currency = 'HKD';
        const merchantEmail = PAYPAL_BUSINESS_EMAIL || 'sb-rbbmt40742598@business.example.com';
        const salt = crypto.randomBytes(16).toString('hex');
        const cartDetails = enrichedCart.map(item => `${item.pid}:${item.quantity}:${item.price}`).join('|');
        const digestInput = `${currency}|${merchantEmail}|${salt}|${cartDetails}|${totalPrice.toFixed(2)}`;
        const digest = crypto.createHash('sha256').update(digestInput).digest('hex');
        console.log('Digest input:', digestInput);

        const [result] = await db.promise().query(
            'INSERT INTO orders (username, currency, merchant_email, salt, cart, total_price, digest) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, currency, merchantEmail, salt, JSON.stringify(enrichedCart), totalPrice, digest]
        );
        const orderID = result.insertId;

        res.json({ orderID, digest });
    } catch (error) {
        console.error('Failed to validate cart:', error);
        res.status(500).json({ error: 'Failed to validate cart.' });
    }
});

app.post('/api/orders', csrfProtection, async (req, res) => {
    try {
        const { cart } = req.body;
        if (!cart || !Array.isArray(cart) || cart.length === 0) {
            return res.status(400).json({ error: 'Invalid cart data' });
        }
        const { jsonResponse, httpStatusCode } = await createOrder(cart);
        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error('Failed to create order:', error);
        res.status(500).json({ error: 'Failed to create order.' });
    }
});

app.post('/api/orders/:orderID/capture', csrfProtection, async (req, res) => {
    try {
        const { orderID } = req.params;
        const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
        res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
        console.error('Failed to capture order:', error);
        res.status(500).json({ error: 'Failed to capture order.' });
    }
});


//Admin

app.post('/adminAddCategory', checkAdmin, csrfProtection, (req, res) => {
    const { name } = req.body;

    const sanitizedName = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} });

    if (!sanitizedName) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    const sql = 'INSERT INTO categories ( name ) VALUES (?)';
    db.query(sql, [sanitizedName], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Category added successfully!');
        res.end('Category added successfully!');
    });
});

app.post('/adminEditCategory', checkAdmin, csrfProtection, (req, res) => {
    const { catid, name} = req.body;

    const sanitizedCatid = parseInt(catid, 10);
    const sanitizedName = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} });

    if (isNaN(sanitizedCatid) || !sanitizedName) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    const sql = 'UPDATE categories SET name=? WHERE catid=?';
    db.query(sql, [sanitizedName, sanitizedCatid], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Category edited successfully!');
        res.end('Category edited successfully!');
    });
});

app.post('/adminDeleteCategory', checkAdmin, csrfProtection, (req, res) => {
    const { catid } = req.body;
    const sanitizedCatid = parseInt(catid, 10);

    if (isNaN(sanitizedCatid)) {
        return res.status(400).json({ error: 'Invalid category ID' });
    }

    db.query('DELETE FROM categories WHERE catid=?', [sanitizedCatid], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Category deleted successfully!');
        res.end(`Category deleted successfully.`);
    });
});

app.post('/adminAddProduct', checkAdmin, upload.single('image1'), csrfProtection, (req, res) => {
    const { catid, name, price, description } = req.body;
    const imageUrl = req.file ? req.file.filename : null;

    console.log(imageUrl);

    const sanitizedName = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} });
    const sanitizedDescription = sanitizeHtml(description, { allowedTags: [], allowedAttributes: {} });
    const sanitizedCatid = parseInt(catid, 10);
    const sanitizedPrice = parseFloat(price);

    if (!sanitizedName || isNaN(sanitizedCatid) || isNaN(sanitizedPrice) || sanitizedPrice < 0) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    const sql = 'INSERT INTO products (catid, name, price, description, image_url) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [sanitizedCatid, sanitizedName, sanitizedPrice, sanitizedDescription, imageUrl], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Product added successfully!');
        res.end('Product added successfully!');
    });
});

app.post('/adminEditProduct', checkAdmin, upload.single('image2'), csrfProtection, (req, res) => {
    const { pid, name, price, description } = req.body;
    const imageUrl = req.file ? req.file.filename : null;

    const sanitizedPid = parseInt(pid, 10);
    const sanitizedName = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} });
    const sanitizedDescription = sanitizeHtml(description, { allowedTags: [], allowedAttributes: {} });
    const sanitizedPrice = parseFloat(price);

    if (isNaN(sanitizedPid) || !sanitizedName || isNaN(sanitizedPrice) || sanitizedPrice < 0) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    const sql = 'UPDATE products SET name=?, price=?, description=?, image_url=? WHERE pid=?';
    db.query(sql, [sanitizedName, sanitizedPrice, sanitizedDescription, imageUrl, sanitizedPid], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Product edited successfully!');
        res.end('Product edited successfully!');
    });
});

app.post('/adminDeleteProduct', checkAdmin, csrfProtection, (req, res) => {
    const { pid } = req.body;
    const sanitizedPid = parseInt(pid, 10);

    if (isNaN(sanitizedPid)) {
        return res.status(400).json({ error: 'Invalid product ID' });
    }

    db.query('DELETE FROM products WHERE pid=?', [sanitizedPid], (err) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log('Product deleted successfully!');
        res.end(`Product deleted successfully.`);
    });
});

app.get('/', (req, res) => {
    db.query('SELECT * FROM categories', (err, categories) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(categories);
    });
});

app.get('/productList', (req, res) => {
    db.query('SELECT * FROM products', (err, products) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(products);
    });
});

app.get('/categories', (req, res) => {
    const catid = parseInt(req.query.catid, 10);
    
    if (isNaN(catid)) return res.status(400).json({ error: 'Invalid category ID' });

    db.query('SELECT * FROM categories WHERE catid = ?', [catid], (err, products) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(products);
    });
});

app.get('/productPath', (req, res) => {
    const pid = parseInt(req.query.pid, 10);

    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid product ID' });

    db.query('SELECT * FROM products WHERE pid = ?', [pid], (err, products) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(products);
    });
});

app.get('/products', (req, res) => {
    const catid = parseInt(req.query.catid, 10);

    if (isNaN(catid)) return res.status(400).json({ error: 'Invalid category ID' });

    db.query('SELECT * FROM products WHERE catid = ?', [catid], (err, products) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(products);
    });
});

app.get('/productInformation', (req, res) => {
    const pid = parseInt(req.query.pid, 10);

    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid product ID' });

    db.query('SELECT * FROM products WHERE pid = ?', [pid], (err, product) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (product.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json(product);
    });
});

app.get('/navigationcategoryPath', (req, res) => {
    const catid = parseInt(req.query.catid, 10);

    if (isNaN(catid)) return res.status(400).json({ error: 'Invalid category ID' });

    db.query('SELECT * FROM categories WHERE catid = ?', [catid], (err, category) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(category);
    });
});

app.get('/getProductDetails', (req, res) => {
    const pid = parseInt(req.query.pid, 10);

    if (isNaN(pid)) return res.status(400).json({ error: 'Invalid product ID' });

    const sql = 'SELECT name, price FROM products WHERE pid = ?';
    db.query(sql, [pid], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).send('Product not found');
        }
        res.json(results[0]);
    });
});
  
// Login route
app.post('/login', csrfProtection, async (req, res) => {
    const { email, password, _csrf } = req.body;

    const sanitizedEmail = sanitizeHtml(email, { allowedTags: [], allowedAttributes: {} });

    if (!sanitizedEmail || !password) return res.status(400).json({ error: 'Invalid input' });

    db.query('SELECT * FROM users WHERE email = ?', [sanitizedEmail], async (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const sessionToken = crypto.randomBytes(16).toString('hex');
        db.query('UPDATE users SET session_token = ? WHERE userid = ?', [sessionToken, user.userid]);

        res.cookie('authToken', sessionToken, {
            httpOnly: true,
            secure: false,
            maxAge: 2 * 24 * 60 * 60 * 1000,
            sameSite: 'Strict',
            path: '/',
        });

        console.log('Login successfully! Setting Cookie: authToken=', sessionToken);
        res.json({ isAdmin: user.is_admin === 1, email: user.email });
    });
});

// Check auth status
app.get('/check-auth', (req, res) => {
    console.log('Check-auth - Received Cookie:', req.cookies.authToken);
    
    const token = req.cookies.authToken;
    if (!token) {
        return res.json({ authenticated: false });
    }

    db.query('SELECT * FROM users WHERE session_token = ?', [token], (err, results) => {
        if (err || results.length === 0) {
            return res.json({ authenticated: false });
        }
        const user = results[0];
        res.json({ authenticated: true, isAdmin: user.is_admin === 1, email: user.email });
    });
});

// Logout route
app.post('/logout', csrfProtection, (req, res) => {
    const token = req.cookies.authToken;
    if (token) {
        db.query('UPDATE users SET session_token = NULL WHERE session_token = ?', [token]);
    }
    res.clearCookie('authToken');
    res.sendStatus(200);
});

// Change password route
app.post('/change-password', authenticate, csrfProtection, async (req, res) => {
    const { currentPassword, newPassword, _csrf } = req.body;
    const user = req.user;

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    db.query(
        'UPDATE users SET password = ?, session_token = NULL WHERE userid = ?',
        [hashedNewPassword, user.userid],
        (err) => {
            if (err) {
                console.error('Error updating password:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.clearCookie('authToken');
            res.json({ message: 'Password changed successfully' });
        }
    );
});

//

app.get('/memberOrdersTable', authenticate, csrfProtection, (req, res) => {
    const userEmail = req.user.email;

    const sql = `
        SELECT order_id, cart, total_price, status, created_at
        FROM orders
        WHERE username = ?
        ORDER BY created_at DESC
        LIMIT 5
    `;
    db.query(sql, [userEmail], (err, results) => {
        if (err) {
            console.error('Error fetching orders:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const orders = results.map(order => ({
            orderId: order.order_id,
            products: JSON.parse(order.cart).map(item => ({
                name: item.name,
                price: parseFloat(item.price),
                quantity: parseInt(item.quantity, 10)
            })),
            total: parseFloat(order.total_price),
            status: order.status,
            date: order.created_at
        }));

        res.json(orders);
    });
});

app.get('/adminOrdersTable', checkAdmin, csrfProtection, (req, res) => {
    const sql = `
        SELECT order_id, username, cart, total_price, status, created_at
        FROM orders
        ORDER BY created_at DESC
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Error fetching orders:', err);
            return res.status(500).json({ error: 'Database error' });
        }

        const orders = results.map(order => ({
            orderId: order.order_id,
            username: order.username,
            products: JSON.parse(order.cart).map(item => ({
                name: item.name,
                price: parseFloat(item.price),
                quantity: parseInt(item.quantity, 10)
            })),
            total: parseFloat(order.total_price),
            status: order.status,
            date: order.created_at
        }));

        res.json(orders);
    });
});

app.get('/adminChatHistory', checkAdmin, csrfProtection, (req, res) => {
    const sql = `
        SELECT message_id, username, user_message, ai_response, created_at
        FROM chatHistory
        ORDER BY created_at DESC
    `;
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Error fetching chat history:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        const chatHistory = results.map(chat => ({
            messageId: chat.message_id,
            username: chat.username,
            userMessage: chat.user_message,
            aiResponse: chat.ai_response,
            createdAt: chat.created_at
        }));
        res.json(chatHistory);
    });
});


app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Multer error: ${err.message}` });
    }
    if (err.message.includes('Images only')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

app.post('/chat', async (req, res) => {
    const { message } = req.body;

    const token = req.cookies.authToken;
    let username = 'guest';
    console.log('Chat endpoint - Received Cookie: authToken=', token);
    
    if (token) {
        try {
            const [user] = await db.promise().query('SELECT email FROM users WHERE session_token = ?', [token]);
            console.log('Chat endpoint - User query result:', user);
            if (user.length) {
                username = user[0].email;
            } else {
                console.log('Chat endpoint - No user found for token:', token);
            }
        } catch (err) {
            console.error('Chat endpoint - Error querying user:', err);
        }
    } else {
        console.log('Chat endpoint - No authToken cookie received');
    }

    try {
        const response = await client.path("/chat/completions").post({
            body: {
                messages: [
                    { role: "system", content: "You are a helpful customer service assistant." },
                    { role: "user", content: message }
                ],
                max_tokens: 500,
                model: AZURE_MODEL_NAME
            }
        });

        if (response.status !== "200") {
            throw new Error(response.body.error.message || 'Failed to get chat completion');
        }

        let rawReply = response.body.choices[0].message.content;
        console.log('Raw API Response:', rawReply);

        const thinkStartIndex = rawReply.indexOf('<think>');
        const thinkEndIndex = rawReply.indexOf('</think>');
        if (thinkStartIndex !== -1 && thinkEndIndex !== -1) {
            rawReply = rawReply.substring(0, thinkStartIndex) + rawReply.substring(thinkEndIndex + 8).trim();
        }

        const reply = rawReply;

        await db.promise().query(
            'INSERT INTO chatHistory (username, user_message, ai_response) VALUES (?, ?, ?)',
            [username, message, reply]
        );

        res.json({ reply });
    } catch (error) {
        console.error('Error in /chat endpoint:', error.message);
        res.status(500).json({ reply: 'Sorry, there was an error processing your request.' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
