function clearCart() {
    localStorage.setItem('cart', JSON.stringify([]));

    const cartItems = document.querySelector('#cart-items');
    const cartTotal = document.querySelector('#cart-total');
    if (cartItems) cartItems.innerHTML = '';
    if (cartTotal) cartTotal.textContent = 'Total: $0.00';
}

function checkPaymentSuccess() {
  const urlParams = new URLSearchParams(window.location.search);
  const paymentStatus = urlParams.get('payment');
  console.log('Payment status:', paymentStatus); 

  if (paymentStatus === 'success') {
    const modal = document.getElementById('payment-modal');
    if (modal) {
      console.log('Showing modal'); 
      modal.style.display = 'flex';

      clearCart();

      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      console.error('Modal element not found'); 
    }
  } else {
    console.log('No payment success parameter found'); 
  }
}

function closeModal() {
  const modal = document.getElementById('payment-modal');
  if (modal) {
    console.log('Hiding modal'); 
    modal.style.display = 'none';
  } else {
    console.error('Modal element not found in closeModal'); 
  }
}

async function getCsrfToken() {
    try {
      const response = await fetch('http://localhost:3000/csrf-token', {
        credentials: 'include',
      });
      const data = await response.json();
      return data.csrfToken;
    } catch (error) {
      console.error('Error fetching CSRF token:', error);
      return null;
    }
}

function getRawCart() {
    try {
        const cart = JSON.parse(localStorage.getItem('cart')) || [];
        console.log('Raw cart from localStorage:', cart);
        return cart.filter(item => item.pid && parseInt(item.quantity, 10) > 0);
    } catch (error) {
        console.error('Error retrieving cart:', error);
        return [];
    }
}  

async function populatePaypalForm(cart) {
    const form = document.getElementById('paypal-form');

    form.querySelectorAll('[name^="item_name_"], [name^="item_number_"], [name^="quantity_"]').forEach(input => input.remove());
    

    for (let i = 0; i < cart.length; i++) {
        const item = cart[i];
        const index = i + 1; 
        const pid = item.pid;
  
        const response = await fetch(`http://localhost:3000/getProductDetails?pid=${pid}`, { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`Failed to fetch product name for pid ${pid}`);
        }
        const product = await response.json();
        
        const itemNameInput = document.createElement('input');
        itemNameInput.type = 'hidden';
        itemNameInput.name = `item_name_${index}`;
        itemNameInput.value = product.name;
        form.appendChild(itemNameInput);

        const itemNumberInput = document.createElement('input');
        itemNumberInput.type = 'hidden';
        itemNumberInput.name = `item_number_${index}`;
        itemNumberInput.value = pid;
        form.appendChild(itemNumberInput);

        const quantityInput = document.createElement('input');
        quantityInput.type = 'hidden';
        quantityInput.name = `quantity_${index}`;
        quantityInput.value = item.quantity;
        form.appendChild(quantityInput);

        const amountInput = document.createElement('input');
        amountInput.type = 'hidden';
        amountInput.name = `amount_${index}`;
        amountInput.value = parseFloat(product.price).toFixed(2); 
        form.appendChild(amountInput);
    }
}

async function initializeCheckout() {
    const checkoutButton = document.getElementById('checkout-button');
    if (!checkoutButton) {
        console.error('Checkout button not found');
        return;
    }

    checkoutButton.addEventListener('click', async (event) => {
        event.preventDefault(); 

        const csrfToken = await getCsrfToken();
        if (!csrfToken) {
            resultMessage('Could not initialize checkout: CSRF token fetch failed.');
            return;
        }

        const cart = getRawCart();
        if (cart.length === 0) {
            resultMessage('If your shopping cart is empty, please add products before checking out.');
            return;
        }

        try {
            const response = await fetch('http://localhost:3000/api/validate-cart', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrfToken,
                },
                credentials: 'include',
                body: JSON.stringify({ cart }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to validate cart');
            }

            const { orderID, digest } = await response.json();
            console.log('Received orderID:', orderID, 'Digest:', digest);

            await populatePaypalForm(cart);

            document.getElementById('invoice').value = orderID;
            document.getElementById('custom').value = digest;

            const form = document.getElementById('paypal-form');
            form.submit();
        } catch (error) {
            console.error('Checkout error:', error);
            resultMessage(`Could not process checkout:<br><br>${error.message}`);
        }
    });
}

function resultMessage(message) {
    const container = document.querySelector('#result-message');
    if (container) container.innerHTML = message;
}

document.addEventListener('DOMContentLoaded', () => {
    initializeCheckout();
    console.log('DOM fully loaded, checking payment success'); 
    checkPaymentSuccess();
});
  