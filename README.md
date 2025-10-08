
# IB API | Services | Training | ChatGPT | Accelerator | Payment

```
Repo:  ib-api-services-training-chatgpt-accelerator-apply
Route: api.innovationbound.com/services/training/chatgpt/accelerator/payment
```

Process payment or invoice request for 2026 AI Accelerator

## NPM scripts

- **zip** - Zips up the lambda function code
- **create** - Zips new lambda configures it with defaults and send it up to AWS
- **deploy** - Zips lambda and replaces the code of the one already up in AWS
- **logs** - Spits out _unfilterd_ logs
- **reset-env** - Resets environment variables to supplied string, for example `npm run reset-env NODE_ENV=production,DB_KEY=secret`
- **test** - Runs node test.js

## Getting the Lambda hooked up

Remember to work with devapi.innovationbound.com first, and deploy to development stage first.

1. First, add the appropriate **Methods, Headers**, and anything else you need in your Lambda code.
2. Go to the `ib` API Gateway in the AWS Console.
3. Add one or more new resources for the path you want.
4. **DO NOT Enable CORS** from API Gateway for any resources, it's handled in Lambda.
5. Add an **OPTIONS Method** and any other method you want in APIGateway (just to the final resource).
6. Use **Lambda Proxy Integratino** for all methods you need including OPTIONS.
7. Test things in the API Gateway console first!
8. **Deploy the API** now that it has the new resource and both methods.
9. Any new updates to the lambda will immediately take effect.

