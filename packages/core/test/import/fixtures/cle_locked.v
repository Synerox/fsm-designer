module CLE (clk, reset, mem_d, mem_a, mem_sel, mem_wen, finish, test_se, SCAN_IN_1, SCAN_OUT_1);
input         clk;
input         reset;
 
inout  [7:0]  mem_d;
 
output [9:0]  mem_a;
output        mem_sel;
output        mem_wen;
output        finish;
 
input         test_se;
input         SCAN_IN_1;
 
output        SCAN_OUT_1;
 
wire          i_clk;
wire          i_reset;
 
wire   [7:0]  i_mem_d;
wire   [7:0]  o_mem_d;
wire          e_mem_d;
 
wire   [9:0]  i_mem_a;
wire          i_mem_sel;
wire          i_mem_wen;
wire          i_finish;
 
wire          i_test_se;
wire          i_SCAN_IN_1;
wire          i_SCAN_OUT_1;
 
XMD ipad_CLK   (.I(clk),      .O(i_clk));
XMD ipad_RESET (.I(reset),    .O(i_reset));
 
ZMA2GSD iopad_MEM_D_Q0(.IO(mem_d[0]),.I(i_mem_d[0]),.O(o_mem_d[0]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q1(.IO(mem_d[1]),.I(i_mem_d[1]),.O(o_mem_d[1]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q2(.IO(mem_d[2]),.I(i_mem_d[2]),.O(o_mem_d[2]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q3(.IO(mem_d[3]),.I(i_mem_d[3]),.O(o_mem_d[3]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q4(.IO(mem_d[4]),.I(i_mem_d[4]),.O(o_mem_d[4]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q5(.IO(mem_d[5]),.I(i_mem_d[5]),.O(o_mem_d[5]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q6(.IO(mem_d[6]),.I(i_mem_d[6]),.O(o_mem_d[6]),.E(e_mem_d));
ZMA2GSD iopad_MEM_D_Q7(.IO(mem_d[7]),.I(i_mem_d[7]),.O(o_mem_d[7]),.E(e_mem_d));
 
YA2GSD opad_MEM_A_Q0(.I(i_mem_a[0]),.O(mem_a[0]),.E(1'b1));
YA2GSD opad_MEM_A_Q1(.I(i_mem_a[1]),.O(mem_a[1]),.E(1'b1));
YA2GSD opad_MEM_A_Q2(.I(i_mem_a[2]),.O(mem_a[2]),.E(1'b1));
YA2GSD opad_MEM_A_Q3(.I(i_mem_a[3]),.O(mem_a[3]),.E(1'b1));
YA2GSD opad_MEM_A_Q4(.I(i_mem_a[4]),.O(mem_a[4]),.E(1'b1));
YA2GSD opad_MEM_A_Q5(.I(i_mem_a[5]),.O(mem_a[5]),.E(1'b1));
YA2GSD opad_MEM_A_Q6(.I(i_mem_a[6]),.O(mem_a[6]),.E(1'b1));
YA2GSD opad_MEM_A_Q7(.I(i_mem_a[7]),.O(mem_a[7]),.E(1'b1));
YA2GSD opad_MEM_A_Q8(.I(i_mem_a[8]),.O(mem_a[8]),.E(1'b1));
YA2GSD opad_MEM_A_Q9(.I(i_mem_a[9]),.O(mem_a[9]),.E(1'b1));
YA2GSD opad_MEM_SEL  (.I(i_mem_sel), .O(mem_sel), .E(1'b1));
YA2GSD opad_MEM_WEN  (.I(i_mem_wen), .O(mem_wen), .E(1'b1));
YA2GSD opad_FINISH   (.I(i_finish),  .O(finish),  .E(1'b1));
 
XMD ipad_TEST_SE   (.I(test_se),   .O(i_test_se));
XMD ipad_SCAN_IN_1 (.I(SCAN_IN_1), .O(i_SCAN_IN_1));
 
YA2GSD opad_SCAN_OUT_1(.I(i_SCAN_OUT_1),.O(SCAN_OUT_1),.E(1'b1));
 
CLE_core core (
    .clk       (i_clk),
    .reset     (i_reset),
    .mem_d_in  (o_mem_d),
    .mem_d_out (i_mem_d),
    .mem_d_oe  (e_mem_d),
    .mem_a     (i_mem_a),
    .mem_sel   (i_mem_sel),
    .mem_wen   (i_mem_wen),
    .finish    (i_finish),
    .test_se   (i_test_se),
    .SCAN_IN_1 (i_SCAN_IN_1),
    .SCAN_OUT_1(i_SCAN_OUT_1)
);
 
endmodule
 
 
module CLE_core (
    input         clk,
    input         reset,
 
    input  [7:0]  mem_d_in,
    output [7:0]  mem_d_out,
    output        mem_d_oe,
 
    output [9:0]  mem_a,
    output        mem_sel,
    output        mem_wen,
    output        finish,
 
    input         test_se,
    input         SCAN_IN_1,
    output        SCAN_OUT_1
);
 
integer i;

reg [3:0]  cs, ns;
 
localparam KEY_IN     = 4'd0;
localparam IDLE       = 4'd1;
localparam READ_ROM_1 = 4'd2;
localparam SCAN       = 4'd3;
localparam WAIT_1     = 4'd4;
localparam READ_ROM_2 = 4'd5;
localparam MERGE      = 4'd6;
localparam FINISH     = 4'd7;
localparam WAIT_2     = 4'd8;
localparam READ_ROM_3 = 4'd9;
localparam RESCAN     = 4'd10;
localparam WAIT_SRAM  = 4'd11;
localparam READ_SRAM  = 4'd12;
localparam RELABEL    = 4'd13;
localparam WAIT_3     = 4'd14;
localparam READ_ROM_4 = 4'd15;

reg [4:0]  X, Y;
reg [4:0]  new_label;
reg [4:0]  fifo [0:32];
reg [31:0] eq_table [0:31];
reg        finish;
reg [0:7]  img;
reg [4:0]  gold_label;
reg [4:0]  top_left, top, top_right, left;
reg [1:0]  eq;
reg        check_eq;
reg        update;
reg [4:0]  label_buffer;
reg [6:0]  rom_a_buffer;

reg [63:0] key;
reg [3:0]  key_cnt;

localparam [63:0] CORRECT_KEY = 64'h04ef4a1c1a05e113;
localparam [63:0] K2_AS       = CORRECT_KEY;

wire [63:0] K1 = key[63:0];

wire [63:0] as_stimulus = {
    X[4:0],
    Y[4:0],
    img[0:7],
    new_label[4:0],
    rom_a_buffer[6:0],
    eq_table[0][7:0],
    fifo[0][4:0],
    top[4:0],
    cs[3:0],
    label_buffer[4:0],
    left[4:0],
    update,
    check_eq
};


wire as_g   = &(as_stimulus ^ K1);
wire as_f   = ~(&(as_stimulus ^ K2_AS));
wire as_out = as_g & as_f;

reg [7:0] write_data;
reg       mem_sel_reg;
reg       mem_wen_reg;
reg [9:0] mem_a_reg;
 
assign mem_sel   = mem_sel_reg;
assign mem_wen   = mem_wen_reg;
assign mem_a     = mem_a_reg;
assign mem_d_out = write_data;
assign mem_d_oe  = (mem_sel_reg == 1'b1 && mem_wen_reg == 1'b0);


always @(negedge clk or posedge reset) begin
    if (reset) begin
        mem_sel_reg <= 1'b0;
        mem_wen_reg <= 1'b1;
        write_data  <= 8'd0;
        mem_a_reg   <= 10'd0;
    end
    else begin
        write_data <= {3'b000, gold_label};
 
        if (cs == SCAN || cs == RELABEL) begin
            mem_sel_reg <= 1'b1;
            mem_wen_reg <= 1'b0 ^ (K1[63] ^ CORRECT_KEY[63]);
            mem_a_reg   <= { X ^ (K1[62:58] ^ CORRECT_KEY[62:58]),
                             Y ^ (K1[57:53] ^ CORRECT_KEY[57:53]) };
        end
        else if (cs == WAIT_SRAM || cs == READ_SRAM) begin
            mem_sel_reg <= 1'b1;
            mem_wen_reg <= 1'b1;
            mem_a_reg   <= { X ^ (K1[62:58] ^ CORRECT_KEY[62:58]),
                             Y ^ (K1[57:53] ^ CORRECT_KEY[57:53]) };
        end
        else begin
            mem_sel_reg <= 1'b0;
            mem_wen_reg <= 1'b1;
            mem_a_reg   <= {3'b000, rom_a_buffer};
        end
    end
end

always @(*) begin
    top_left  = fifo[32];
    top       = fifo[31];
    top_right = fifo[30];
    left      = fifo[0];
 
    if (img[Y[2:0]]) begin
        if (cs == SCAN) begin
            if (top_left == 5'd0 && top == 5'd0 && top_right == 5'd0 && left == 5'd0) begin
                update     = 1'b1 ^ (K1[27] ^ CORRECT_KEY[27]);
                gold_label = new_label ^ (K1[26:22] ^ CORRECT_KEY[26:22]);
                check_eq   = 1'b0;
                eq         = 2'd0;
            end
            else begin
                update = 1'b0;
                if (top_left != 5'd0) begin
                    gold_label = top_left ^ (K1[21:17] ^ CORRECT_KEY[21:17]);
                end
                else if (top != 5'd0) begin
                    gold_label = top ^ (K1[16:12] ^ CORRECT_KEY[16:12]);
                end
                else if (top_right != 5'd0) begin
                    gold_label = top_right ^ (K1[11:7] ^ CORRECT_KEY[11:7]);
                end
                else if (left != 5'd0) begin
                    gold_label = left ^ (K1[6:2] ^ CORRECT_KEY[6:2]);
                end
                else begin
                    gold_label = new_label ^ (K1[26:22] ^ CORRECT_KEY[26:22]);
                end
 
                if (top_left != 5'd0 && top_right != 5'd0 && top_left != top_right) begin
                    eq       = 2'd1;
                    check_eq = 1'b1 ^ (K1[1] ^ CORRECT_KEY[1]);
                end
                else if (left != 5'd0 && top_right != 5'd0 && left != top_right) begin
                    eq       = 2'd2;
                    check_eq = 1'b1 ^ (K1[1] ^ CORRECT_KEY[1]);
                end
                else begin
                    eq       = 2'd0;
                    check_eq = 1'b0;
                end
            end
        end
        else begin
            update     = 1'b0;
            check_eq   = 1'b0;
            eq         = 2'd0;
            gold_label = label_buffer;
            for (i = 31; i >= 0; i = i - 1) begin
                if (eq_table[label_buffer][i] == 1'b1)
                    gold_label = i[4:0];
            end
        end
    end
    else begin
        update     = 1'b0;
        gold_label = 5'd0;
        check_eq   = 1'b0;
        eq         = 2'd0;
    end
end

always @(posedge clk or posedge reset) begin
    if (reset) begin
        cs <= KEY_IN;
    end
    else begin
        cs <= ns;
    end
end

always @(posedge clk or posedge reset) begin
    if (reset) begin
        for (i = 0; i <= 32; i = i + 1) begin
            fifo[i] <= 5'd0;
        end
    end
    else if (cs == SCAN) begin
        fifo[0] <= gold_label;
        for (i = 0; i <= 31; i = i + 1) begin
            fifo[i+1] <= fifo[i];
        end
    end
end

always @(posedge clk or posedge reset) begin
    if (reset) begin
        key          <= 64'd0;
        key_cnt      <= 4'd0;
        X            <= 5'd0;
        Y            <= 5'd0;
        rom_a_buffer <= 7'd0;
        new_label    <= 5'd1;
        img          <= 8'd0;
        finish       <= 1'b0;
        label_buffer <= 5'd0;
        for (i = 0; i <= 31; i = i + 1) begin
            eq_table[i] <= 32'd0;
        end
    end
    else begin
        case (cs)
            KEY_IN: begin
                key     <= {key[55:0], mem_d_in};
                key_cnt <= key_cnt + 4'd1;
            end
 
            IDLE: begin
            end
 
            READ_ROM_1: begin
                img          <= mem_d_in;
                rom_a_buffer <= rom_a_buffer + 7'd1;
            end
 
            SCAN: begin
                Y <= Y + 5'd1;
                if (Y == 5'd31) begin
                    X <= X + 5'd1;
                end
 
                if (update) begin
                    new_label <= new_label + 5'd1;
                end
 
                if (check_eq) begin
                    case (eq)
                        2'd1: begin
                            eq_table[top_left][top_right] <=
                                1'b1 ^ (K1[0] ^ CORRECT_KEY[0]) ^ as_out;
                            eq_table[top_right][top_left] <=
                                1'b1 ^ (K1[0] ^ CORRECT_KEY[0]) ^ as_out;
                        end
                        2'd2: begin
                            eq_table[left][top_right] <=
                                1'b1 ^ (K1[0] ^ CORRECT_KEY[0]) ^ as_out;
                            eq_table[top_right][left] <=
                                1'b1 ^ (K1[0] ^ CORRECT_KEY[0]) ^ as_out;
                        end
                    endcase
                end
            end
 
            WAIT_1: begin
            end
 
            READ_ROM_2: begin
                img          <= mem_d_in;
                rom_a_buffer <= rom_a_buffer + 7'd1;
            end
 
            MERGE: begin
                Y <= Y + 5'd1;
                for (i = 1; i <= 31; i = i + 1) begin
                    eq_table[i] <= (eq_table[i][Y]) ?
                                   (eq_table[i] | eq_table[Y]) :
                                   eq_table[i];
                end
            end
 
            FINISH: begin
                X            <= 5'd0;
                Y            <= 5'd0;
                rom_a_buffer <= 7'd0;
                new_label    <= 5'd0;
            end
 
            WAIT_2: begin
            end
 
            READ_ROM_3: begin
                img          <= mem_d_in;
                rom_a_buffer <= rom_a_buffer + 7'd1;
            end
 
            RESCAN: begin
                if (!img[Y[2:0]]) begin
                    Y <= Y + 5'd1;
                    if (Y == 5'd31) begin
                        X <= X + 5'd1;
                    end

                    if (X == 5'd31 && Y == 5'd31) begin
                        finish <= 1'b1;
                    end
                    else begin
                        finish <= 1'b0;
                    end
                end
            end
 
            WAIT_SRAM: begin
            end

            READ_SRAM: begin
                label_buffer <= mem_d_in[4:0];
            end

            RELABEL: begin
                Y <= Y + 5'd1;
                if (Y == 5'd31) begin
                    X <= X + 5'd1;
                end
            end
 
            WAIT_3: begin
            end
 
            READ_ROM_4: begin
                img          <= mem_d_in;
                rom_a_buffer <= rom_a_buffer + 7'd1;
            end
        endcase
    end
end

always @(*) begin
    case (cs)
        KEY_IN: begin
            ns = (key_cnt == 4'd7) ? IDLE : KEY_IN;
        end
 
        IDLE: begin
            ns = READ_ROM_1;
        end

        READ_ROM_1: begin
            ns = SCAN;
        end
 
        SCAN: begin
            if (X == (5'd31 ^ (K1[52:48] ^ CORRECT_KEY[52:48])) &&
                Y == (5'd31 ^ (K1[47:43] ^ CORRECT_KEY[47:43]))) begin
                ns = MERGE;
            end
            else if (Y[2:0] == 3'd7) begin
                ns = WAIT_1;
            end
            else begin
                ns = SCAN;
            end
        end
 
        WAIT_1: begin
            ns = READ_ROM_2;
        end

        READ_ROM_2: begin
            ns = SCAN;
        end
 
        MERGE: begin
            ns = (Y == (5'd31 ^ (K1[42:38] ^ CORRECT_KEY[42:38]))) ? FINISH : MERGE;
        end
 
        FINISH: begin
            ns = WAIT_2;
        end

        WAIT_2: begin
            ns = READ_ROM_3;
        end

        READ_ROM_3: begin
            ns = RESCAN;
        end
 
        RESCAN: begin
            if (img[Y[2:0]]) begin
                ns = WAIT_SRAM;
            end
            else if (X == (5'd31 ^ (K1[37:33] ^ CORRECT_KEY[37:33])) &&
                     Y == (5'd31 ^ (K1[32:28] ^ CORRECT_KEY[32:28]))) begin
                ns = IDLE;
            end
            else if (Y[2:0] == 3'd7) begin
                ns = WAIT_2;
            end
            else begin
                ns = RESCAN;
            end
        end
 
        WAIT_SRAM: begin
            ns = READ_SRAM;
        end

        READ_SRAM: begin
            ns = RELABEL;
        end
 
        RELABEL: begin
            ns = (Y[2:0] == 3'd7) ? WAIT_3 : RESCAN;
        end
 
        WAIT_3: begin
            ns = READ_ROM_4;
        end

        READ_ROM_4: begin
            ns = RESCAN;
        end
 
        default: begin
            ns = KEY_IN;
        end
    endcase
end
 
endmodule