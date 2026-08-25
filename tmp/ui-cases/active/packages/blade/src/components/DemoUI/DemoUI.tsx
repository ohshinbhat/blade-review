import React from 'react';
import { Box, Button, Typography } from '@razorpay/blade/components';

export const DemoUI = (): React.ReactElement => (
  <Box>
    <Typography>Payment total</Typography>
    <Typography>₹500</Typography>
    <Button variant="secondary">Pay now</Button>
  </Box>
);
