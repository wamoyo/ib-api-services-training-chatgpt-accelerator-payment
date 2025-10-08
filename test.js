
/*
 * Testing payment lambda function
 * Note: Requires Stripe test keys and AWS credentials to run
 */

import { handler } from './index.js'

// Test 1: Credit card payment (requires valid Stripe test payment method)
var creditCardPayment = {
  httpMethod: 'POST',
  body: JSON.stringify({
    payment: {
      applicant: "costa@trollhair.com",
      name: "Costa Michailidis",
      finalFee: "$13,500",
      additionalSeats: 5,
      paymentMethod: "credit-card",
      company: "TrollHair Inc",
      jobTitle: "CTO",
      phone: "+1-212-206-1401",
      country: "United States",
      paymentMethodId: "pm_card_visa" // Stripe test payment method
    }
  })
}

// Test 2: Invoice request
var invoiceRequest = {
  httpMethod: 'POST',
  body: JSON.stringify({
    payment: {
      applicant: "costa@trollhair.com",
      name: "Costa Michailidis",
      finalFee: "$21,000",
      additionalSeats: 2,
      paymentMethod: "invoice",
      company: "TrollHair Inc",
      jobTitle: "CTO",
      phone: "+1-212-206-1401",
      country: "United States"
    }
  })
}

// Test 3: Invalid tier (should fail)
var invalidTier = {
  httpMethod: 'POST',
  body: JSON.stringify({
    payment: {
      applicant: "costa@trollhair.com",
      name: "Costa Michailidis",
      finalFee: "$10,000", // Not a valid tier
      additionalSeats: 0,
      paymentMethod: "invoice",
      company: "TrollHair Inc",
      jobTitle: "CTO",
      phone: "+1-212-206-1401",
      country: "United States"
    }
  })
}

// Test 4: Missing required field (should fail)
var missingField = {
  httpMethod: 'POST',
  body: JSON.stringify({
    payment: {
      applicant: "costa@trollhair.com",
      name: "Costa Michailidis",
      finalFee: "$6,000",
      additionalSeats: 0,
      paymentMethod: "credit-card"
      // Missing company, jobTitle, phone, country
    }
  })
}

// Test 5: OPTIONS preflight (CORS)
var optionsRequest = {
  httpMethod: 'OPTIONS'
}

console.log('Running payment Lambda test...\n')

// CHANGE THIS LINE TO SWITCH TESTS:
var testToRun = creditCardPayment  // Change to: creditCardPayment

if (testToRun === invoiceRequest) {
  console.log('Testing INVOICE REQUEST for costa@trollhair.com')
  console.log('This will:')
  console.log('- Create/update application record in DynamoDB')
  console.log('- Create student record in DynamoDB')
  console.log('- Send invoice request email to costa@trollhair.com\n')
} else {
  console.log('Testing CREDIT CARD PAYMENT for costa@trollhair.com')
  console.log('This will:')
  console.log('- Process Stripe test payment')
  console.log('- Create/update application record in DynamoDB')
  console.log('- Create student record in DynamoDB')
  console.log('- Send payment confirmation email to costa@trollhair.com\n')
}

handler(testToRun)
  .then(result => {
    console.log('\n✅ SUCCESS!\n')
    console.log('Response:', JSON.stringify(result, null, 2))
    console.log('\nNext steps:')
    console.log('1. Check DynamoDB for records:')
    console.log('   - application#ai-accelerator / costa@trollhair.com')
    console.log('   - student#ai-accelerator / costa@trollhair.com')
    console.log('2. Check email inbox at costa@trollhair.com')
    console.log('3. Clean up DynamoDB records when done testing')
  })
  .catch(error => {
    console.error('\n❌ ERROR!\n')
    console.error(error)
  })
