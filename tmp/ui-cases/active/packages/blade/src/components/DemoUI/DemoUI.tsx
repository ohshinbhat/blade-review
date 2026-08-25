import React from 'react';
import { Box, Button, Typography } from '@razorpay/blade/components';

export const DemoUI = (): React.ReactElement => (
  <Box>
    <Typography>Order total</Typography>
    <Typography>₹500</Typography>
    <Button variant="primary">Pay now</Button>
  </Box>
);
